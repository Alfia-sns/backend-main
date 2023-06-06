const express = require('express');
const app = express();
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Inisialisasi cloud storage
const cors = require('cors');
const { Storage } = require('@google-cloud/storage');
const uuid = require('uuid'); // Import library uuid

const storage = new Storage();
const bucketName = 'storyverse-app.appspot.com';
const datasetFilename = 'dataset.csv';
const datasetBucket = storage.bucket(bucketName);
const datasetFile = datasetBucket.file(datasetFilename);

// Inisialisasi Firebase Admin SDK
const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

app.use(express.json());
app.use(cors());

// Konfigurasi multer untuk upload foto
const uploadFoto = multer({
    limits: { fileSize: 50000 }, // Batasan ukuran file: 50KB
    storage: multer.diskStorage({
        destination: function (req, file, cb) {
            cb(null, 'Upload_foto/');
        },
        filename: function (req, file, cb) {
            cb(null, file.originalname);
        }
    })
});

// Konfigurasi multer untuk upload stories
const uploadStories = multer({
    storage: multer.diskStorage({
        destination: function (req, file, cb) {
            cb(null, 'Upload_stories/');
        },
        filename: function (req, file, cb) {
            cb(null, file.originalname.replace(path.extname(file.originalname), '.txt'));
        }
    })
});

// API endpoint untuk user register
app.post('/api/register', async (req, res) => {
    const { name, email, password } = req.body;

    // validasi panjang password
    if (password.length < 8) {
        return res.status(400).json({ error: true, message: 'Password must be at least 8 characters' });
    }

    try {
        // cek apakah email sudah terdaftar
        const snapshot = await db.collection('users').where('email', '==', email).get();
        if (!snapshot.empty) {
            return res.status(400).json({ error: true, message: 'Email already exists' });
        }

        // menyimpan data user ke firebase
        await db.collection('users').add({ name, email, password });

        // respon sukses
        res.status(201).json({ error: false, message: 'User Created' });
    } catch (error) {
        // respon jika ada kesalahan data
        console.error('Error registering user:', error);
        res.status(500).json({ error: true, message: 'Failed to register user' });
    }
});

// API endpoint untuk user login
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;

    try {
        // mencari user berdasarkan email
        const querySnapshot = await db.collection('users').where('email', '==', email).get();
        if (querySnapshot.empty) {
            return res.status(404).json({ error: true, message: 'User not found' });
        }

        // ambil data user dari hasil query
        const user = querySnapshot.docs[0].data();

        // verifikasi password
        if (user.password !== password) {
            return res.status(401).json({ error: true, message: 'Invalid password' });
        }

        // generate custom token JWT menggunakan Firebase Admin SDK
        const uid = querySnapshot.docs[0].id;
        const customToken = await admin.auth().createCustomToken(uid);

        // respon dengan data user dan token
        res.status(200).json({
            error: false,
            message: 'Success',
            loginResult: {
                userId: uid,
                name: user.name,
                token: customToken,
            },
        });
    } catch (error) {
        // respon jika terjadi kesalahan saat akses database
        console.error('Error logging in:', error);
        res.status(500).json({ error: true, message: 'Failed to login' });
    }
});

// API endpoint untuk cloud storage
app.get('/api/dataset', async (req, res) => {
    try {
        // Read the dataset file
        const stream = datasetFile.createReadStream();

        // Process the dataset
        const dataset = [];

        const csv = require('csv-parser');

        stream
            .pipe(csv())
            .on('data', (data) => {
                const { Title, Created_date, Author, Url, Category } = data;
                const id = uuid.v4();
                dataset.push({ id, Title, Created_date, Author, Url, Category });
            })
            .on('end', () => {
                // Return the dataset as a response
                res.json(dataset);
            })
            .on('error', (err) => {
                console.error(err);
                res.status(500).json({ error: 'Internal Server Error' });
            });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// API endpoint untuk upload foto
app.post('/api/upload/foto', uploadFoto.single('foto'), async (req, res) => {
    const foto = req.file;

    // Validasi ukuran foto
    if (!foto || foto.size > 50000) {
        // Hapus foto yang sudah diupload jika melebihi batasan ukuran
        if (foto) {
            fs.unlinkSync(foto.path);
        }
        return res.status(400).json({ error: true, message: 'Invalid foto' });
    }

    // Menyimpan foto ke cloud storage
    const bucket = storage.bucket(bucketName);
    const fotoFile = bucket.file(`Upload_foto/${foto.originalname}`);
    await fotoFile.save(foto.buffer, {
        contentType: foto.mimetype,
        resumable: false
    });

    // Respon sukses
    res.status(200).json({ error: false, message: 'Foto uploaded successfully' });
});

// API endpoint untuk upload stories
app.post('/api/upload/stories', uploadStories.single('stories'), async (req, res) => {
    const stories = req.file;

    // Validasi stories
    if (!stories) {
        return res.status(400).json({ error: true, message: 'Invalid stories' });
    }

    // Menyimpan stories ke cloud storage
    const bucket = storage.bucket(bucketName);
    const storiesFile = bucket.file(`Upload_stories/${path.basename(stories.originalname, path.extname(stories.originalname))}.txt`);
    await storiesFile.save(stories.buffer, {
        contentType: 'text/plain',
        resumable: false
    });

    // Respon sukses
    res.status(200).json({ error: false, message: 'Stories uploaded successfully' });
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});
