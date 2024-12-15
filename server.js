const express = require('express');
const app = express();
const path = require("path");
const session = require('express-session');
const port = process.env.PORT || 3000;
require("dotenv").config({ path: path.resolve(__dirname, 'auth/.env') }) 
const { MongoClient, ObjectId } = require("mongodb");
const uri = `mongodb+srv://${process.env.MONGO_DB_USERNAME}:${process.env.MONGO_DB_PASSWORD}@gorbatyfinancialservice.hwyzw.mongodb.net/?retryWrites=true&w=majority&appName=GorbatyFinancialServices`;
const client = new MongoClient(uri);
const bcrypt = require('bcryptjs');
const ALPHA_VANTAGE_API_KEY = process.env.ALPHA_VANTAGE_API;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// REMOVE: FOR TESTING
console.log("API Key:", process.env.ALPHA_VANTAGE_API_KEY);

// configuration for user session info
app.use(session({
    secret: 'your-secret-key',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false } // true if using HTTPS
}));

// connecting the client
let db;
client.connect()
    .then(() => {
        db = client.db(process.env.MONGO_DB_NAME);
    })
    .catch(err => console.error("Failed to connect to MongoDB", err));

// function to set cookie status
function setLoginCookie() {
    document.cookie = "loggedIn=true; path=/; max-age=86400"; //1 day
}

// function to check if a user is logged in
function isLoggedIn() {
    return document.cookie.includes("loggedIn=true");
}

app.listen(port, () => {
    console.log(`Gorbaty Financial Services  ${port}\n`);
});

app.use(express.static('public'));

// configuration for ejs
app.set("views", path.resolve(__dirname, "templates"));
app.set("view engine", "ejs");

// rendering the main/front page
app.get("/", (req, res) => {
    res.render('index');
});

// rendering the processApplication
app.get("/login", (req, res) => {
    res.render('login');
});

app.get("/sign-up", (req, res) => {
    res.render('signup');
});

app.get('/dashboard', async (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }

    try {
        const portfolios = req.session.user.portfolios || [];
        const portfolioData = [];

        //fetch stock prices for each portfolio to sum them all up
        for (const portfolio of portfolios) {
            let totalValue = 0;
            const positions = [];

            for (const position of portfolio.positions) {
                const { ticker, quantity } = position;

                //fetching ticker info from alpha vantage
                const response = await fetch(
                    `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${ticker}&apikey=${ALPHA_VANTAGE_API_KEY}`
                );

                if (!response.ok) {
                    console.error(`Failed to fetch data for ticker ${ticker}: ${response.statusText}`);
                    continue;
                }

                console.log("API Response:", response);
                const data = await response.json();
                console.log(data)
                const price = parseFloat(data['Global Quote']['05. price'] || 0);
                const value = price * quantity;

                totalValue += value;
                positions.push({ ticker, quantity, price });
            }

            portfolioData.push({
                name: portfolio.name,
                totalValue: totalValue.toFixed(2),
                positions
            });
        }

        const totalPortfolioValue = portfolioData.reduce((acc, portfolio) => {
            const portfolioValue = parseFloat(portfolio.totalValue) || 0;
            return acc + portfolioValue;
        }, 0);
        res.render('dashboard', {
            username: req.session.user.username,
            portfolios: portfolioData,
            totalPortfolioValue
        });
    } catch (error) {
        console.error('Error fetching stock prices:', error);
        res.status(500).send('Error fetching stock prices');
    }
});

app.post("/process-login", express.urlencoded({ extended: true }), async (req, res) => {
    const { email, password } = req.body;
    const formattedEmail = email.toLowerCase();
    try {
        const applications = db.collection(process.env.MONGO_COLLECTION);
        const user = await applications.findOne({ email: formattedEmail }); // finding logged user
        if (user) {
            const passwordMatch = await bcrypt.compare(password, user.password);
            if (passwordMatch) {
                //save user data in session
                req.session.user = {
                    id: user._id.toString(),
                    username: user.username,
                    email: user.email,
                    portfolios: user.portfolios || []
                };
                const username = user.username;
                res.render('processlogin', { username });
            } else {
                res.status(401).send("Invalid email or password.");
            }
        } else {
            res.status(404).send("No account found with that email. Please sign up.");
        }
    } catch (err) {
        console.error("Error connecting to db", err);
        res.status(500).send("Error processing application.");
    }
});


app.post("/process-signup", express.urlencoded({ extended: true }), async (req, res) => {
    const { email, username, password } = req.body;

    try {
        const applications = db.collection(process.env.MONGO_COLLECTION);
        const existingUser = await applications.findOne({ email }); // Check if email already exists
        if (existingUser) {
            res.status(400).send("You already have an account. Please sign in.");
        } else {
            bcrypt.genSalt(10, function (err, Salt) {

                // encrypting password for save storage
                bcrypt.hash(password, Salt, async function (err, hash) {
            
                    if (err) {
                        return console.log(`Cannot encrypt ${err}`);
                    }
                    const formattedEmail = email.toLowerCase()
                    const newUser = {
                        email: formattedEmail,
                        username,
                        password: hash,
                        portfolios: [],
                        timeCreated: new Date(),
                    };
                    
                    const result = await applications.insertOne(newUser);
                    try {
                        //save user data in session
                        req.session.user = {
                            id: result.insertedId,
                            username: newUser.username,
                            email: newUser.email,
                            portfolios: newUser.portfolios || []
                        };
                        res.render('processlogin', { username });
                    } catch (err) {
                        console.error("Error finding logged user", err);
                        res.status(500).send("Error processing login.");
                    }
                    
                    
                })
            })
        }
    } catch (err) {
        console.error("Error inserting application:", err);
        res.status(500).send("Error processing application.");
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            console.error(err);
            res.send('Error logging out');
        } else {
            res.redirect('/');
        }
    });
});

app.post('/add-portfolio', async (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }

    const { portfolioName, tickers, quantities } = req.body;

    //positions array
    const positions = tickers.map((ticker, index) => ({
        ticker: ticker,
        quantity: parseInt(quantities[index], 10),
    }));

    //portfolio object
    const newPortfolio = {
        name: portfolioName,
        positions: positions
    };

    try {
        //update the user's portfolios in the database
        const applications = db.collection(process.env.MONGO_COLLECTION);
        const result = await applications.updateOne(
            { email: req.session.user.email },
            { $addToSet: { portfolios: newPortfolio } }
        );

        //update session data
        if (!req.session.user.portfolios) {
            req.session.user.portfolios = [];
        }
        req.session.user.portfolios.push(newPortfolio);

        //redirect to dashboard for consistent data formatting
        res.redirect('/dashboard');
    } catch (error) {
        console.error("Error updating user's portfolios:", error);
        res.status(500).send('An error occurred while adding the portfolio.');
    }
});

app.post('/delete-portfolio', async (req, res) => {
    if (!req.session.user) {
        return res.status(401).send('Unauthorized');
    }

    const { portfolioName } = req.body;

    try {
        req.session.user.portfolios = req.session.user.portfolios.filter(
            (portfolio) => portfolio.name !== portfolioName
        );

        //remove the portfolio from the database
        const applications = db.collection(process.env.MONGO_COLLECTION);
        const result = await applications.updateOne(
            { email: req.session.user.email },
            { $pull: { portfolios: { name: portfolioName } } } // Remove portfolio with matching name
        );

        res.status(200).send('Portfolio deleted successfully');
    } catch (error) {
        console.error('Error deleting portfolio:', error);
        res.status(500).send('An error occurred while deleting the portfolio.');
    }
});


