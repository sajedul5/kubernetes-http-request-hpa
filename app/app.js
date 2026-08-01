const express = require("express");
const client = require("prom-client");

const app = express();
const port = process.env.PORT || 3000;

// Register default Node.js metrics
client.collectDefaultMetrics();

// Counter for total HTTP requests
const httpRequests = new client.Counter({
  name: "http_requests_total",
  help: "Total HTTP Requests",
  labelNames: ["method", "route", "status"]
});

// Histogram for request duration
const requestDuration = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration",
  labelNames: ["method", "route", "status"],
  buckets: [0.05, 0.1, 0.2, 0.5, 1, 2, 5]
});

// Middleware
app.use((req, res, next) => {

    const end = requestDuration.startTimer();

    res.on("finish", () => {
        httpRequests.inc({
            method: req.method,
            route: req.path,
            status: res.statusCode
        });

        end({
            method: req.method,
            route: req.path,
            status: res.statusCode
        });
    });

    next();
});

app.get("/", (req, res) => {

    res.json({
        message: "Hello from Kubernetes",
        hostname: process.env.HOSTNAME,
        timestamp: new Date()
    });

});

app.get("/health", (req, res) => {

    res.send("OK");

});

app.get("/metrics", async (req, res) => {

    res.set("Content-Type", client.register.contentType);
    res.end(await client.register.metrics());

});

app.listen(port, () => {

    console.log(`Application running on port ${port}`);

});