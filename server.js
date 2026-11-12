
const express = require("express");
const Razorpay = require("razorpay");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

// CORS support
app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader(
        "Access-Control-Allow-Methods",
        "GET, POST, OPTIONS"
    );
    res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization"
    );

    if (req.method === "OPTIONS") {
        return res.sendStatus(204);
    }

    next();
});

app.use(express.json({ limit: "20kb" }));
app.use(express.static(__dirname));

// Check environment variables
if (
    !process.env.SUPABASE_URL ||
    !process.env.SUPABASE_SERVICE_ROLE_KEY ||
    !process.env.RAZORPAY_KEY_ID ||
    !process.env.RAZORPAY_KEY_SECRET
) {
    console.error("Missing required environment variables in .env");
    process.exit(1);
}

// Supabase connection
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Razorpay connection
const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
});

// Razorpay authentication check
razorpay.orders.all({ count: 1 })
    .then(() => {
        console.log("RAZORPAY AUTH CHECK: SUCCESS");
    })
    .catch((error) => {
        console.error(
            "RAZORPAY AUTH CHECK: FAILED",
            error?.error?.description ||
            error?.description ||
            error?.message ||
            "Unknown error"
        );
    });

// Health check
app.get("/api/health", (req, res) => {
    res.json({
        status: "ok",
        message: "WallHaven backend is running"
    });
});

// Get published wallpapers
app.get("/api/wallpapers", async (req, res) => {
    try {
        const { data, error } = await supabase
            .from("wallpapers")
            .select(
                "id, title, description, category, price_paise, preview_url"
            )
            .eq("is_published", true)
            .order("created_at", { ascending: false });

        if (error) throw error;

        res.json({ wallpapers: data });

    } catch (error) {
        console.error("Wallpaper query failed:", error.message);

        res.status(500).json({
            error: "Unable to load wallpapers"
        });
    }
});

// Create Razorpay order
app.post("/api/create-order", async (req, res) => {
    try {
        const { wallpaperId } = req.body || {};

        if (
            typeof wallpaperId !== "string" ||
            !wallpaperId.trim()
        ) {
            return res.status(400).json({
                error: "Wallpaper ID is required"
            });
        }

        const { data: wallpaper, error } = await supabase
            .from("wallpapers")
            .select("id, price_paise, is_published")
            .eq("id", wallpaperId)
            .eq("is_published", true)
            .single();

        if (error || !wallpaper) {
            return res.status(404).json({
                error: "Wallpaper not found"
            });
        }

        const amount = Number(wallpaper.price_paise);

        if (!Number.isSafeInteger(amount) || amount <= 0) {
            return res.status(400).json({
                error: "Invalid wallpaper price"
            });
        }

        const order = await razorpay.orders.create({
            amount,
            currency: "INR",
            receipt: "wallhaven_" + Date.now(),
            notes: {
                wallpaper_id: wallpaper.id
            }
        });

        res.json({
            id: order.id,
            amount: order.amount,
            currency: order.currency,
            keyId: process.env.RAZORPAY_KEY_ID
        });

    } catch (error) {
        console.error(
            "Order creation failed:",
            error?.error?.description ||
            error?.description ||
            error?.message ||
            String(error)
        );

        res.status(500).json({
            error: "Unable to create order"
        });
    }
});

// Verify payment and create secure download token
app.post("/api/verify-payment", async (req, res) => {
    try {
        const {
            razorpay_order_id,
            razorpay_payment_id,
            razorpay_signature
        } = req.body || {};

        if (
            typeof razorpay_order_id !== "string" ||
            typeof razorpay_payment_id !== "string" ||
            typeof razorpay_signature !== "string"
        ) {
            return res.status(400).json({
                verified: false,
                error: "Missing payment details"
            });
        }

        // Verify Razorpay signature
        const expectedSignature = crypto
            .createHmac(
                "sha256",
                process.env.RAZORPAY_KEY_SECRET
            )
            .update(
                razorpay_order_id + "|" + razorpay_payment_id
            )
            .digest("hex");

        const received = Buffer.from(razorpay_signature, "utf8");
        const expected = Buffer.from(expectedSignature, "utf8");

        if (
            received.length !== expected.length ||
            !crypto.timingSafeEqual(received, expected)
        ) {
            return res.status(400).json({
                verified: false,
                error: "Invalid payment signature"
            });
        }

        // Verify directly with Razorpay
        const order = await razorpay.orders.fetch(
            razorpay_order_id
        );

        const payment = await razorpay.payments.fetch(
            razorpay_payment_id
        );

        const wallpaperId = order.notes?.wallpaper_id;

        if (
            !wallpaperId ||
            order.id !== razorpay_order_id ||
            order.status !== "paid"
        ) {
            return res.status(400).json({
                verified: false,
                error: "Order is not paid or wallpaper is missing"
            });
        }

        // Verify wallpaper
        const { data: wallpaper, error } = await supabase
            .from("wallpapers")
            .select("id, price_paise, is_published")
            .eq("id", wallpaperId)
            .eq("is_published", true)
            .single();

        if (error || !wallpaper) {
            return res.status(400).json({
                verified: false,
                error: "Wallpaper is unavailable"
            });
        }

        const expectedAmount = Number(wallpaper.price_paise);

        // Verify actual payment details
        if (
            order.amount !== expectedAmount ||
            order.currency !== "INR" ||
            payment.order_id !== razorpay_order_id ||
            payment.status !== "captured" ||
            payment.currency !== "INR" ||
            payment.amount !== expectedAmount
        ) {
            return res.status(400).json({
                verified: false,
                error: "Payment details do not match"
            });
        }

        // Save verified purchase
        const { error: purchaseError } = await supabase
            .from("wallpaper_purchases")
            .upsert(
                {
                    razorpay_payment_id: payment.id,
                    wallpaper_id: wallpaper.id
                },
                {
                    onConflict: "razorpay_payment_id",
                    ignoreDuplicates: true
                }
            );

        if (purchaseError) {
            console.error(
                "Purchase save failed:",
                purchaseError.message
            );

            return res.status(500).json({
                verified: false,
                error: "Could not save purchase"
            });
        }

        // Generate secure random token
        const downloadToken = crypto
            .randomBytes(32)
            .toString("hex");

        // Store only SHA-256 hash
        const tokenHash = crypto
            .createHash("sha256")
            .update(downloadToken)
            .digest("hex");

        // Token expires after 10 minutes
        const expiresAt = new Date(
            Date.now() + 10 * 60 * 1000
        ).toISOString();

        const { data: tokenRows, error: tokenError } = await supabase
            .from("wallpaper_purchases")
            .update({
                download_token_hash: tokenHash,
                download_token_expires_at: expiresAt,
                download_token_used_at: null
            })
            .eq("razorpay_payment_id", payment.id)
            .eq("wallpaper_id", wallpaper.id)
            .select("id");

        if (tokenError || !tokenRows || tokenRows.length === 0) {
            console.error(
                "Token save failed:",
                tokenError?.message || "Purchase row not found"
            );

            return res.status(500).json({
                verified: false,
                error: "Could not create download access"
            });
        }

        console.log("Download token created and saved.");

        console.log("TOKEN SAVE CHECK:", {
            rowsSaved: tokenRows.length,
            hashLength: tokenHash.length,
            expiry: expiresAt
        });

        res.json({
            verified: true,
            paymentStatus: payment.status,
            wallpaperId: wallpaper.id,
            paymentId: payment.id,
            downloadToken: downloadToken
        });

    } catch (error) {
        console.error(
            "Payment verification failed:",
            error.message
        );

        res.status(500).json({
            verified: false,
            error: "Unable to verify payment"
        });
    }
});

// Premium secure one-time download API
app.post("/api/download", async (req, res) => {
    try {
        const { downloadToken } = req.body || {};

        console.log("Download token diagnostic:", {
            isString: typeof downloadToken === "string",
            length:
                typeof downloadToken === "string"
                    ? downloadToken.length
                    : 0,
            validFormat:
                typeof downloadToken === "string" &&
                /^[a-f0-9]{64}$/.test(downloadToken)
        });

        if (
            typeof downloadToken !== "string" ||
            !/^[a-f0-9]{64}$/.test(downloadToken)
        ) {
            return res.status(400).json({
                error: "Invalid download token"
            });
        }

        // Hash received token
        const tokenHash = crypto
            .createHash("sha256")
            .update(downloadToken)
            .digest("hex");

        // Find valid unused token
        const { data: purchase, error } = await supabase
            .from("wallpaper_purchases")
            .select("id, wallpaper_id")
            .eq("download_token_hash", tokenHash)
            .gt(
                "download_token_expires_at",
                new Date().toISOString()
            )
            .is("download_token_used_at", null)
            .maybeSingle();

        if (error) {
            console.error(
                "Token database check failed:",
                error.message
            );

            return res.status(500).json({
                error: "Unable to check download access"
            });
        }

        if (!purchase) {
            return res.status(403).json({
                error: "Token expired or already used"
            });
        }

        // Get private wallpaper path
        const { data: wallpaper, error: wallpaperError } =
            await supabase
                .from("wallpapers")
                .select("storage_path, is_published")
                .eq("id", purchase.wallpaper_id)
                .eq("is_published", true)
                .single();

        if (
            wallpaperError ||
            !wallpaper ||
            !wallpaper.storage_path
        ) {
            console.error(
                "Wallpaper lookup failed:",
                wallpaperError?.message || "File path missing"
            );

            return res.status(404).json({
                error: "Wallpaper file not found"
            });
        }

        // Create signed URL that forces file download
        const { data: signed, error: signedError } =
            await supabase.storage
                .from("wallpaper-files")
                .createSignedUrl(
                    wallpaper.storage_path,
                    60,
                    { download: true }
                );

        if (signedError || !signed?.signedUrl) {
            console.error(
                "Signed URL failed:",
                signedError?.message
            );

            return res.status(500).json({
                error: "Could not create download link"
            });
        }

        // Consume token once
        const { data: consumed, error: consumeError } =
            await supabase
                .from("wallpaper_purchases")
                .update({
                    download_token_used_at:
                        new Date().toISOString()
                })
                .eq("id", purchase.id)
                .eq("download_token_hash", tokenHash)
                .is("download_token_used_at", null)
                .gt(
                    "download_token_expires_at",
                    new Date().toISOString()
                )
                .select("id")
                .maybeSingle();

        if (consumeError || !consumed) {
            console.error(
                "Token consumption failed:",
                consumeError?.message || "Token unavailable"
            );

            return res.status(403).json({
                error: "Download token already used or expired"
            });
        }

        console.log("Premium download link created.");

        res.json({
            downloadUrl: signed.signedUrl,
            expiresInSeconds: 60
        });

    } catch (error) {
        console.error("Download failed:", error.message);

        res.status(500).json({
            error: "Unable to process download"
        });
    }
});

// Free wallpaper download API
app.post("/api/free-download", async (req, res) => {
    try {
        const { wallpaperId } = req.body || {};

        if (
            typeof wallpaperId !== "string" ||
            !wallpaperId.trim()
        ) {
            return res.status(400).json({
                error: "Wallpaper ID is required"
            });
        }

        // Fetch published wallpaper
        const { data: wallpaper, error } = await supabase
            .from("wallpapers")
            .select("id, price_paise, storage_path, is_published")
            .eq("id", wallpaperId)
            .eq("is_published", true)
            .single();

        if (error || !wallpaper) {
            return res.status(404).json({
                error: "Wallpaper not found"
            });
        }

        // Free downloads only
        if (Number(wallpaper.price_paise) !== 0) {
            return res.status(403).json({
                error: "This wallpaper is not free"
            });
        }

        if (!wallpaper.storage_path) {
            return res.status(404).json({
                error: "Wallpaper file not found"
            });
        }

        // Create signed URL that forces file download
        const { data: signed, error: signedError } =
            await supabase.storage
                .from("wallpaper-files")
                .createSignedUrl(
                    wallpaper.storage_path,
                    60,
                    { download: true }
                );

        if (signedError || !signed?.signedUrl) {
            console.error(
                "Free download URL failed:",
                signedError?.message
            );

            return res.status(500).json({
                error: "Could not create download link"
            });
        }

        console.log("Free download link created.");

        res.json({
            downloadUrl: signed.signedUrl,
            expiresInSeconds: 60
        });

    } catch (error) {
        console.error("Free download failed:", error.message);

        res.status(500).json({
            error: "Unable to process free download"
        });
    }
});

// Start server
app.listen(PORT, () => {
    console.log(
        `WallHaven backend running at http://localhost:${PORT}`
    );
});
