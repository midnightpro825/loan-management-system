const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const multer = require('multer');
const fs = require('fs');
const PDFDocument = require('pdfkit');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(session({
    secret: process.env.SESSION_SECRET || 'loan-secret-key-2024',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = './public/uploads';
        if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname);
    }
});
const upload = multer({ storage: storage });

const db = new sqlite3.Database('loans.db');

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fullname TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        phone TEXT,
        work_place TEXT,
        is_admin INTEGER DEFAULT 0,
        wallet_balance REAL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS loan_types (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        description TEXT,
        min_amount REAL,
        max_amount REAL,
        default_interest REAL
    )`);

    const loanTypes = [
        ['personal', 'Personal loans', 500, 50000, 8.5],
        ['business', 'Business loans', 1000, 100000, 7.5],
        ['car', 'Car loans', 2000, 80000, 6.5],
        ['home', 'Home loans', 5000, 200000, 5.5]
    ];
    
    loanTypes.forEach(type => {
        db.run(`INSERT OR IGNORE INTO loan_types (name, description, min_amount, max_amount, default_interest) VALUES (?, ?, ?, ?, ?)`, type);
    });

    db.run(`CREATE TABLE IF NOT EXISTS loans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        loan_type_id INTEGER,
        amount REAL,
        interest_rate REAL,
        term_months INTEGER,
        monthly_payment REAL,
        total_payable REAL,
        remaining_balance REAL,
        status TEXT DEFAULT 'pending',
        purpose TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (loan_type_id) REFERENCES loan_types(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS repayments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        loan_id INTEGER,
        amount REAL,
        payment_method TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (loan_id) REFERENCES loans(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS withdrawals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        amount REAL,
        method TEXT,
        bank_name TEXT,
        account_number TEXT,
        card_number TEXT,
        mobile_number TEXT,
        status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS admin_payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        loan_id INTEGER,
        amount REAL,
        payment_method TEXT,
        payment_details TEXT,
        status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (loan_id) REFERENCES loans(id)
    )`);
});

// ============ AUTHENTICATION ============

app.post('/api/register', async (req, res) => {
    const { fullname, email, password, phone, work_place } = req.body;
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        db.run(`INSERT INTO users (fullname, email, password, phone, work_place) VALUES (?, ?, ?, ?, ?)`,
            [fullname, email, hashedPassword, phone, work_place],
            function(err) {
                if (err) return res.status(400).json({ error: 'Email already exists' });
                res.json({ success: true, userId: this.lastID });
            });
    } catch (error) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/login', (req, res) => {
    const { email, password } = req.body;
    db.get(`SELECT * FROM users WHERE email = ?`, [email], async (err, user) => {
        if (err || !user) return res.status(401).json({ error: 'Invalid credentials' });
        const valid = await bcrypt.compare(password, user.password);
        if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
        req.session.userId = user.id;
        req.session.isAdmin = user.is_admin === 1;
        res.json({ success: true, user: { id: user.id, fullname: user.fullname, email: user.email, wallet_balance: user.wallet_balance, isAdmin: user.is_admin === 1 } });
    });
});

app.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

app.get('/api/me', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
    db.get(`SELECT id, fullname, email, phone, work_place, wallet_balance, is_admin FROM users WHERE id = ?`, [req.session.userId], (err, user) => {
        if (err || !user) return res.status(404).json({ error: 'User not found' });
        res.json({ ...user, isAdmin: user.is_admin === 1 });
    });
});

function requireAdmin(req, res, next) {
    if (!req.session.userId) return res.status(401).json({ error: 'Please login first' });
    db.get(`SELECT is_admin FROM users WHERE id = ?`, [req.session.userId], (err, user) => {
        if (err || !user || user.is_admin !== 1) return res.status(403).json({ error: 'Admin access required' });
        next();
    });
}

// ============ ADMIN ROUTES ============

app.get('/api/admin/loans', requireAdmin, (req, res) => {
    db.all(`SELECT l.*, u.fullname, u.email, lt.name as loan_type_name FROM loans l JOIN users u ON l.user_id = u.id JOIN loan_types lt ON l.loan_type_id = lt.id ORDER BY l.created_at DESC`, [], (err, loans) => {
        res.json(loans || []);
    });
});

app.put('/api/admin/loan/:id/status', requireAdmin, (req, res) => {
    const { status } = req.body;
    const { id } = req.params;
    db.run(`UPDATE loans SET status = ? WHERE id = ?`, [status, id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

app.get('/api/admin/users', requireAdmin, (req, res) => {
    db.all(`SELECT id, fullname, email, phone, work_place, wallet_balance FROM users ORDER BY created_at DESC`, [], (err, users) => {
        res.json(users || []);
    });
});

app.post('/api/admin/wallet/add', requireAdmin, (req, res) => {
    const { user_id, amount } = req.body;
    db.run(`UPDATE users SET wallet_balance = wallet_balance + ? WHERE id = ?`, [amount, user_id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

app.get('/api/admin/withdrawals', requireAdmin, (req, res) => {
    db.all(`SELECT w.*, u.fullname, u.email FROM withdrawals w JOIN users u ON w.user_id = u.id WHERE w.status = 'pending' ORDER BY w.created_at DESC`, [], (err, withdrawals) => {
        res.json(withdrawals || []);
    });
});

app.put('/api/admin/withdrawal/:id/process', requireAdmin, (req, res) => {
    const { status } = req.body;
    const { id } = req.params;
    db.run(`UPDATE withdrawals SET status = ?, processed_at = CURRENT_TIMESTAMP WHERE id = ?`, [status, id], (err) => {
        res.json({ success: true });
    });
});

app.get('/api/admin/payments', requireAdmin, (req, res) => {
    db.all(`SELECT p.*, u.fullname, u.email FROM admin_payments p JOIN users u ON p.user_id = u.id WHERE p.status = 'pending' ORDER BY p.created_at DESC`, [], (err, payments) => {
        res.json(payments || []);
    });
});

app.put('/api/admin/payment/:id/confirm', requireAdmin, (req, res) => {
    const { id } = req.params;
    db.run(`UPDATE admin_payments SET status = 'completed', processed_at = CURRENT_TIMESTAMP WHERE id = ?`, [id], (err) => {
        res.json({ success: true });
    });
});

// ============ USER ROUTES ============

app.get('/api/loan-types', (req, res) => {
    db.all(`SELECT * FROM loan_types`, [], (err, types) => {
        res.json(types || []);
    });
});

app.post('/api/apply-loan', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Login first' });
    const { loan_type_id, amount, term_months, purpose, interest_rate } = req.body;
    const monthlyRate = (interest_rate / 100) / 12;
    const monthlyPayment = monthlyRate > 0 ? amount * (monthlyRate * Math.pow(1 + monthlyRate, term_months)) / (Math.pow(1 + monthlyRate, term_months) - 1) : amount / term_months;
    const totalPayable = monthlyPayment * term_months;
    db.run(`INSERT INTO loans (user_id, loan_type_id, amount, interest_rate, term_months, monthly_payment, total_payable, remaining_balance, purpose) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [req.session.userId, loan_type_id, amount, interest_rate, term_months, monthlyPayment, totalPayable, totalPayable, purpose],
        function(err) { res.json(err ? { error: err.message } : { success: true, loanId: this.lastID }); });
});

app.get('/api/my-loans', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Login first' });
    db.all(`SELECT l.*, lt.name as loan_type_name FROM loans l JOIN loan_types lt ON l.loan_type_id = lt.id WHERE l.user_id = ? ORDER BY l.created_at DESC`, [req.session.userId], (err, loans) => {
        res.json(loans || []);
    });
});

app.post('/api/request-withdrawal', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Login first' });
    const { amount, method, bank_name, account_number, card_number, mobile_number } = req.body;
    if (!amount || amount < 10) return res.status(400).json({ error: 'Minimum withdrawal amount is $10' });
    db.get(`SELECT wallet_balance FROM users WHERE id=?`, [req.session.userId], (err, user) => {
        if (user.wallet_balance < amount) return res.status(400).json({ error: 'Insufficient balance' });
        db.run(`INSERT INTO withdrawals (user_id, amount, method, bank_name, account_number, card_number, mobile_number) VALUES (?,?,?,?,?,?,?)`,
            [req.session.userId, amount, method, bank_name, account_number, card_number, mobile_number],
            (err) => { res.json(err ? { error: err.message } : { success: true }); });
    });
});

app.get('/api/my-withdrawals', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Login first' });
    db.all(`SELECT * FROM withdrawals WHERE user_id=? ORDER BY created_at DESC`, [req.session.userId], (err, withdrawals) => {
        res.json(withdrawals || []);
    });
});

app.post('/api/make-payment', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Login first' });
    const { loan_id, amount, payment_method, payment_details } = req.body;
    db.run(`INSERT INTO admin_payments (user_id, loan_id, amount, payment_method, payment_details) VALUES (?,?,?,?,?)`,
        [req.session.userId, loan_id, amount, payment_method, payment_details],
        (err) => { res.json(err ? { error: err.message } : { success: true }); });
});

app.post('/api/upload-document', upload.single('document'), (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Login first' });
    db.run(`UPDATE users SET id_document=? WHERE id=?`, [`/uploads/${req.file.filename}`, req.session.userId], (err) => {
        res.json({ success: !err });
    });
});

app.get('/api/download-agreement/:loan_id', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Login first' });
    db.get(`SELECT l.*, u.fullname, u.email, lt.name as loan_type_name FROM loans l JOIN users u ON l.user_id=u.id JOIN loan_types lt ON l.loan_type_id=lt.id WHERE l.id=? AND l.user_id=?`, [req.params.loan_id, req.session.userId], (err, loan) => {
        if (err || !loan) return res.status(404).json({ error: 'Loan not found' });
        const doc = new PDFDocument({ margin: 50 });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=loan_agreement_${req.params.loan_id}.pdf`);
        doc.pipe(res);
        doc.fontSize(20).text('LOAN AGREEMENT', { align: 'center' }).moveDown();
        doc.fontSize(12).text(`Date: ${new Date().toLocaleDateString()}`, { align: 'right' }).moveDown();
        doc.fontSize(14).text('1. PARTIES').moveDown(0.5);
        doc.fontSize(11).text(`BORROWER: ${loan.fullname}`).text(`Email: ${loan.email}`).moveDown();
        doc.fontSize(14).text('2. LOAN DETAILS').moveDown(0.5);
        doc.fontSize(11).text(`Loan Amount: $${loan.amount}`).text(`Monthly Payment: $${loan.monthly_payment}`).text(`Term: ${loan.term_months} months`);
        doc.end();
    });
});

// ============ SERVE HTML PAGES ============

app.get('/register.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'register.html')));
app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/dashboard.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/admin.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

if (!fs.existsSync('./public/uploads')) fs.mkdirSync('./public/uploads', { recursive: true });

bcrypt.hash('admin123', 10).then(hash => {
    db.run(`INSERT OR IGNORE INTO users (fullname, email, password, is_admin) VALUES (?, ?, ?, 1)`, ['System Admin', 'admin@fastloan.com', hash]);
    console.log('✅ Admin user ready - Email: admin@fastloan.com / Password: admin123');
});

app.listen(PORT, () => {
    console.log(`✅ Server running at http://localhost:${PORT}`);
    console.log(`🔐 Login: http://localhost:${PORT}/login.html`);
    console.log(`👑 Admin: admin@fastloan.com / admin123`);
});