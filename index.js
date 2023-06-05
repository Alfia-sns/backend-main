const express = require('express');
const app = express();
const axios = require('axios');
const cheerio = require('cheerio');
const multer = require('multer');
const path = require('path');

// Inisialisasi cloud storage
const cors = require('cors');
const { Storage } = require('@google-cloud/storage');
const uuid = require('uuid'); // Import library uuid

const storage = new Storage();
const bucketName = 'storyverse-app.appspot.com';
const datasetFilename = 'dataset.csv';
const datasetBucket = storage.bucket(bucketName);
const datasetFile = datasetBucket.file(datasetFilename);
const uploadFotoFolder = 'Upload_foto/';
const uploadStoriesFolder = 'Upload_stories/';
const fotoBucket = storage.bucket(bucketName).file(uploadFotoFolder);
const storiesBucket = storage.bucket(bucketName).file(uploadStoriesFolder);

const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

app.use(express.json());
app.use(cors());

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
            .on('data', async (data) => {
                const { Title, Created_date, Author, Url, Category } = data;
                const id = uuid.v4();

                // Mengambil konten artikel dari URL menjadi teks
                try {
                    const response = await axios.get(Url);
                    const $ = cheerio.load(response.data);
                    const article = $('article').text();

                    // Mendapatkan nama file foto berdasarkan kategori
                    const categoryCoverImage = `${Category.replace(/\s/g, '_')}.jpg`;

                    dataset.push({ id, Title, Created_date, Author, Url, article, Category, CategoryCoverImage });
                } catch (error) {
                    console.error('Error fetching URL:', Url);
                    console.error(error);
                }
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

// API endpoint untuk mendapatkan data berdasarkan ID
app.get('/api/dataset/:id', (req, res) => {
    const { id } = req.params;

    // Melakukan pencarian dataset berdasarkan ID
    const stream = datasetFile.createReadStream();
    const csv = require('csv-parser');
    let found = false;

    stream
        .pipe(csv())
        .on('data', (data) => {
            const { Title, Created_date, Author, Url, Category } = data;

            // Jika ID dataset cocok, kirim respons
            if (data.id === id) {
                found = true;
                res.json({ id, Title, Created_date, Author, Url, Category });
                stream.destroy();
            }
        })
        .on('end', () => {
            // Jika ID dataset tidak ditemukan, kirim respons error
            if (!found) {
                res.status(404).json({ error: 'Dataset not found' });
            }
        })
        .on('error', (err) => {
            console.error(err);
            res.status(500).json({ error: 'Internal Server Error' });
        });
});

// API endpoint untuk mendapatkan data berdasarkan kategori
app.get('/api/dataset/category/:category', (req, res) => {
    const { category } = req.params;

    // Melakukan pencarian dataset berdasarkan kategori
    const stream = datasetFile.createReadStream();
    const csv = require('csv-parser');
    const datasets = [];

    stream
        .pipe(csv())
        .on('data', (data) => {
            const { Title, Created_date, Author, Url, Category } = data;

            // Jika kategori dataset cocok, tambahkan ke daftar dataset
            if (Category.toLowerCase() === category.toLowerCase()) {
                datasets.push({ Title, Created_date, Author, Url, Category });
            }
        })
        .on('end', () => {
            // Kirim daftar dataset berdasarkan kategori sebagai respons
            res.json(datasets);
        })
        .on('error', (err) => {
            console.error(err);
            res.status(500).json({ error: 'Internal Server Error' });
        });
});

// Konfigurasi multer untuk upload file
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 50000, // batasan ukuran file (50 KB)
    },
    fileFilter: (req, file, cb) => {
        // batasan format file (hanya jpg/png)
        const allowedFileTypes = /jpeg|jpg|png/;
        const extname = allowedFileTypes.test(
            path.extname(file.originalname).toLowerCase()
        );
        const mimetype = allowedFileTypes.test(file.mimetype);
        if (extname && mimetype) {
            cb(null, true);
        } else {
            cb(new Error('Only JPEG and PNG file formats are allowed'));
        }
    },
});


// API endpoint untuk upload foto sampul
app.post('/api/upload/foto', upload.single('foto'), (req, res, next) => {
    if (!req.file) {
        return res
            .status(400)
            .json({ error: true, message: 'No file uploaded' });
    }

    const file = fotoBucket.file(req.file.originalname);
    const blobStream = file.createWriteStream();

    blobStream.on('error', (err) => {
        console.error(err);
        return res
            .status(500)
            .json({ error: true, message: 'Failed to upload photo' });
    });

    blobStream.on('finish', () => {
        return res
            .status(200)
            .json({ error: false, message: 'Photo uploaded successfully' });
    });

    blobStream.end(req.file.buffer);
});

// API endpoint untuk upload cerita
app.post('/api/upload/stories', upload.single('file'), (req, res, next) => {
    if (!req.file) {
        return res
            .status(400)
            .json({ error: true, message: 'No file uploaded' });
    }

    const file = storiesBucket.file(req.file.originalname);
    const blobStream = file.createWriteStream();

    blobStream.on('error', (err) => {
        console.error(err);
        return res
            .status(500)
            .json({ error: true, message: 'Failed to upload story' });
    });

    blobStream.on('finish', () => {
        return res
            .status(200)
            .json({ error: false, message: 'Story uploaded successfully' });
    });

    blobStream.end(req.file.buffer);
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});