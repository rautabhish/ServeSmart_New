const express = require('express');
const cassandra = require('cassandra-driver');
const axios = require('axios');
const bcryptjs = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const app = express();

// Path to the secure connect bundle
const secureConnectBundlePath = path.join(__dirname, 'config', 'secure-connect-smartserve.zip');

// Initialize Cassandra client
const client = new cassandra.Client({
    cloud: {
        secureConnectBundle: secureConnectBundlePath,
    },
    keyspace: 'smartserve', // Ensure this matches your AstraDB keyspace
});

console.log('Cassandra client initialized');

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Yelp API details
const apiKey = process.env.YELP_API_KEY;
const yelpSearchUrl = 'https://api.yelp.com/v3/businesses/search';
const yelpReviewsUrl = (id) => `https://api.yelp.com/v3/businesses/${id}/reviews`;

// Function to fetch data from Yelp and insert into Cassandra
async function fetchDataAndStore() {
    try {
        console.log('Started inserting/updating data into the database...');

        const response = await axios.get(yelpSearchUrl, {
            headers: { Authorization: `Bearer ${apiKey}` },
            params: { location: 'Boston', categories: 'restaurants', limit: 5 },
        });

        for (const business of response.data.businesses) {
            const reviewsResponse = await axios.get(yelpReviewsUrl(business.id), {
                headers: { Authorization: `Bearer ${apiKey}` },
            });

            const reviews = reviewsResponse.data.reviews.map((review) => review.text);

            const selectQuery = 'SELECT id FROM restaurant_info WHERE restaurant_name = ? ALLOW FILTERING';
            const selectParams = [business.name];
            const existingEntry = await client.execute(selectQuery, selectParams, { prepare: true });

            if (existingEntry.rowLength > 0) {
                const updateQuery = `
                    UPDATE restaurant_info
                    SET ratings = ?, reviews = ?
                    WHERE id = ?
                `;
                const updateParams = [business.rating, reviews, existingEntry.rows[0].id];
                await client.execute(updateQuery, updateParams, { prepare: true });
                console.log(`Updated existing restaurant: ${business.name}`);
            } else {
                const insertQuery = `
                    INSERT INTO restaurant_info (id, ratings, restaurant_name, reviews)
                    VALUES (?, ?, ?, ?)
                `;
                const insertParams = [uuidv4(), business.rating, business.name, reviews];
                await client.execute(insertQuery, insertParams, { prepare: true });
                console.log(`Inserted new restaurant: ${business.name}`);
            }
        }
        console.log('Data successfully inserted/updated in the database.');
    } catch (error) {
        console.error('Error fetching data or inserting/updating database:', error);
    }
}

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'signin.html'));
});

app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'dashboard.html'));
});


app.post('/signup', async (req, res) => {
    const { username, password, pin, restaurantName } = req.body;
    const hashedPassword = await bcryptjs.hash(password, 10);
    const query = 'INSERT INTO users (username, password, pin, restaurant_name) VALUES (?, ?, ?, ?)';
    const params = [username, hashedPassword, pin, restaurantName];
    try {
        await client.execute(query, params, { prepare: true });
        res.json({ message: 'User registered successfully!' });
    } catch (error) {
        console.error('Error during signup:', error);
        res.status(500).json({ message: 'Signup failed.' });
    }
});

app.post('/signin', async (req, res) => {
    const { username, password } = req.body;
    const query = 'SELECT * FROM users WHERE username = ?';
    try {
        const result = await client.execute(query, [username], { prepare: true });
        const user = result.rows[0];
        if (user && await bcryptjs.compare(password, user.password)) {
            res.json({ success: true });
        } else {
            res.json({ success: false, message: 'Invalid username or password.' });
        }
    } catch (error) {
        console.error('Error during signin:', error);
        res.status(500).json({ message: 'Signin failed.' });
    }
});

app.post('/dashboard', async (req, res) => {
    const { username, restaurantName, pin } = req.body;

    const userQuery = 'SELECT * FROM users WHERE username = ? AND restaurant_name = ? AND pin = ? ALLOW FILTERING';
    const restaurantQuery = 'SELECT * FROM restaurant_info WHERE restaurant_name = ?';
    const posQuery = 'SELECT * FROM pos_dataset WHERE restaurant_name = ?';

    try {
        const userResult = await client.execute(userQuery, [username, restaurantName, pin], { prepare: true });

        if (userResult.rowLength > 0) {
            const restaurantData = await client.execute(restaurantQuery, [restaurantName], { prepare: true });
            const posData = await client.execute(posQuery, [restaurantName], { prepare: true });

            res.json({
                success: true,
                restaurantData: restaurantData.rows,
                posData: posData.rows,
            });
        } else {
            res.json({ success: false, message: 'Authentication failed. Invalid restaurant name or PIN.' });
        }
    } catch (error) {
        console.error('Error during dashboard request processing:', error);
        res.status(500).json({ success: false, message: 'Server error occurred.' });
    }
});

// Start the server
const port = process.env.PORT || 3000;
app.listen(port, async () => {
    console.log(`Server running at http://localhost:${port}`);
    await fetchDataAndStore();
});
