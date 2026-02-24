const express = require('express');
const bodyParser = require('body-parser');
const { Pool } = require('pg');
const session = require('express-session');

const app = express();

// ================= MIDDLEWARE =================
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.set('view engine', 'ejs');

// ================= SESSION =================
app.use(session({
    secret: 'clean-city-secret-key',
    resave: false,
    saveUninitialized: false
}));

// ================= DATABASE =================
const pool = new Pool({
    user: 'postgres',
    host: 'localhost',
    database: 'clean-city-bot',
    password: 'admin123',
    port: 5432,
});

// ================= AUTH MIDDLEWARE =================
function requireLogin(req, res, next) {
    if (!req.session.admin) {
        return res.redirect('/login');
    }
    next();
}

// ================= LOGIN ROUTES =================
app.get('/login', (req, res) => {
    res.render('login', { error: null });
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;

    if (username === "admin" && password === "Admin@123") {
        req.session.admin = true;
        return res.redirect('/admin');
    }

    res.render('login', { error: "Invalid Credentials" });
});

app.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/login');
    });
});

// ================= WORKFLOW RULES =================
const allowedTransitions = {
    "New": ["Assigned"],
    "Assigned": ["In Progress"],
    "In Progress": ["Awaiting Verification"],
    "Awaiting Verification": ["Resolved"],
    "Resolved": ["Closed", "Reopened"],
    "Reopened": ["In Progress"],
    "Closed": []
};

// ================= TEMP SESSION =================
let sessions = {};

// ================= WHATSAPP WEBHOOK =================
app.post('/webhook', async (req, res) => {

    try {

        const msg = req.body.Body ? req.body.Body.trim() : "";
        const from = req.body.From;
        const numMedia = parseInt(req.body.NumMedia || 0);

        if (!sessions[from]) sessions[from] = { step: 0 };

        let response = "";

        const categories = {
            "1": "Air Pollution",
            "2": "Burning of Garbage",
            "3": "Garbage not lifted",
            "4": "Removal of dead animal",
            "5": "Road not swept",
            "6": "Removal of debris"
        };

        if (msg.toLowerCase() === "hi" || msg.toLowerCase() === "hello") {

            response =
`CLEAN CITY SUPPORT SYSTEM :

1. Register Complaint
2. Check My Complaint Status

Press 1 or 2 to proceed.`;

            sessions[from].step = 0;
        }

        else if (sessions[from].step === 0 && msg === "1") {
            response = "Please send issue location. 📍";
            sessions[from].step = 1;
        }

        else if (sessions[from].step === 1 && req.body.Latitude) {

            sessions[from].location = {
                latitude: req.body.Latitude,
                longitude: req.body.Longitude
            };

            response =
`Select Complaint Category:

1. Air Pollution
2. Burning of Garbage
3. Garbage not lifted
4. Removal of dead animal
5. Road not swept
6. Removal of debris

Reply with number (1-6).`;

            sessions[from].step = 2;
        }

        else if (sessions[from].step === 2) {

            if (categories[msg]) {
                sessions[from].category = categories[msg];
                response = "Provide brief description of the issue.";
                sessions[from].step = 3;
            } else {
                response = "Invalid category. Please select 1-6.";
            }
        }

        else if (sessions[from].step === 3) {
            sessions[from].description = msg;
            response = "Upload image of the issue. 📸";
            sessions[from].step = 4;
        }

        else if (sessions[from].step === 4 && numMedia > 0) {

            const imageUrl = req.body.MediaUrl0;
            const id = `CCS-${new Date().getFullYear()}-${Date.now().toString().slice(-6)}`;

            await pool.query(
                `INSERT INTO complaints
                (complaint_id, category, description, latitude, longitude, image_url, status, priority, mobile_number)
                VALUES ($1,$2,$3,$4,$5,$6,'New','Normal',$7)`,
                [
                    id,
                    sessions[from].category,
                    sessions[from].description,
                    sessions[from].location.latitude,
                    sessions[from].location.longitude,
                    imageUrl,
                    from
                ]
            );

            response =
`Complaint Registered Successfully ✅

Complaint Number: ${id}
Status: New`;

            sessions[from] = { step: 0 };
        }

        else if (sessions[from].step === 0 && msg === "2") {

            const result = await pool.query(
                `SELECT * FROM complaints
                 WHERE mobile_number=$1
                 ORDER BY created_at DESC
                 LIMIT 1`,
                [from]
            );

            if (result.rows.length) {

                const c = result.rows[0];

                response =
`Your Latest Complaint 👇

Complaint Number: ${c.complaint_id}
Category: ${c.category}
Status: ${c.status}
Priority: ${c.priority || "Normal"}`;

            } else {
                response = "No complaints found for your number.";
            }

            sessions[from] = { step: 0 };
        }

        else {
            response = "Invalid input. Type HI to restart.";
        }

        res.send(`<Response><Message>${response}</Message></Response>`);

    } catch (err) {
        console.error("Webhook Error:", err);
        res.send(`<Response><Message>System error occurred.</Message></Response>`);
    }
});

// ================= ADMIN DASHBOARD =================
app.get('/admin', requireLogin, async (req, res) => {

    const stats = await pool.query(`
        SELECT
            COUNT(*) AS total,
            COUNT(*) FILTER (WHERE status='New') AS new_count,
            COUNT(*) FILTER (WHERE status='Assigned') AS assigned,
            COUNT(*) FILTER (WHERE status='In Progress') AS in_progress,
            COUNT(*) FILTER (WHERE status='Resolved') AS resolved,
            COUNT(*) FILTER (WHERE status='Closed') AS closed
        FROM complaints
    `);

    res.render('admin', { stats: stats.rows[0] });
});

// ================= PROTECTED APIs =================
app.get('/api/complaints', requireLogin, async (req, res) => {
    const complaints = await pool.query(
        `SELECT * FROM complaints ORDER BY created_at DESC`
    );
    res.json(complaints.rows);
});

app.post('/update-status', requireLogin, async (req, res) => {

    const { complaint_id, next_status } = req.body;

    const result = await pool.query(
        `SELECT status FROM complaints WHERE complaint_id=$1`,
        [complaint_id]
    );

    if (!result.rows.length)
        return res.status(400).json({ error: "Complaint not found" });

    const current = result.rows[0].status;

    if (!allowedTransitions[current] ||
        !allowedTransitions[current].includes(next_status))
        return res.status(400).json({ error: "Invalid transition" });

    await pool.query(
        `UPDATE complaints
         SET status=$1, updated_at=CURRENT_TIMESTAMP
         WHERE complaint_id=$2`,
        [next_status, complaint_id]
    );

    res.json({ success: true });
});

app.post('/update-priority', requireLogin, async (req, res) => {

    const { complaint_id, priority } = req.body;

    await pool.query(
        `UPDATE complaints
         SET priority=$1, updated_at=CURRENT_TIMESTAMP
         WHERE complaint_id=$2`,
        [priority, complaint_id]
    );

    res.json({ success: true });
});

app.post('/assign', requireLogin, async (req, res) => {

    const { complaint_id, assigned_to } = req.body;

    await pool.query(
        `UPDATE complaints
         SET assigned_to=$1,
             status='Assigned',
             updated_at=CURRENT_TIMESTAMP
         WHERE complaint_id=$2`,
        [assigned_to, complaint_id]
    );

    res.json({ success: true });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});