
const express = require("express");
const Razorpay = require("razorpay");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

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

// Create Razorpay order using the database price
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
        console.error("Order creation failed:", error.message);
        res.status(500).json({
            error: "Unable to create order"
        });
    }
});

// Verify payment and save purchase
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
            .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
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

        // Verify order and payment directly with Razorpay
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

        // Store the verified purchase
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
            console.error("Purchase save failed:", purchaseError.message);
            return res.status(500).json({
                verified: false,
                error: "Could not save purchase"
            });
        }

        res.json({
            verified: true,
            paymentStatus: payment.status,
            wallpaperId: wallpaper.id,
            paymentId: payment.id
        });
    } catch (error) {
        console.error("Payment verification failed:", error.message);
        res.status(500).json({
            verified: false,
            error: "Unable to verify payment"
        });
    }
});

// Create a temporary download URL for a recorded purchase
app.post("/api/download", async (req, res) => {
    try {
        const { paymentId } = req.body || {};

        if (
            typeof paymentId !== "string" ||
            !paymentId.trim()
        ) {
            return res.status(400).json({
                error: "Payment ID is required"
            });
        }

        // Find the saved purchase
        const { data: purchase, error: purchaseError } =
            await supabase
                .from("wallpaper_purchases")
                .select("wallpaper_id")
                .eq("razorpay_payment_id", paymentId)
                .maybeSingle();

        if (purchaseError || !purchase) {
            return res.status(403).json({
                error: "Purchase record not found"
            });
        }

        // Read the private file path
        const { data: wallpaper, error: wallpaperError } =
            await supabase
                .from("wallpapers")
                .select("id, storage_path, is_published")
                .eq("id", purchase.wallpaper_id)
                .eq("is_published", true)
                .single();

        if (
            wallpaperError ||
            !wallpaper ||
            !wallpaper.storage_path
        ) {
            return res.status(404).json({
                error: "Wallpaper file not found"
            });
        }

        // Create a link that expires after 60 seconds
        const { data: signed, error: signedError } =
            await supabase.storage
                .from("wallpaper-files")
                .createSignedUrl(wallpaper.storage_path, 60);

        if (signedError || !signed?.signedUrl) {
            console.error(
                "Signed URL failed:",
                signedError?.message
            );
            return res.status(500).json({
                error: "Could not create download link"
            });
        }

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

app.listen(PORT, () => {
    console.log(
        `WallHaven backend running at http://localhost:${PORT}`
    );
});
