// api/index.js (FINAL & STABIL - Serverless Export für Vercel)

import express from 'express';
import dotenv from 'dotenv';
import Replicate from 'replicate';
import cors from 'cors';
import { NeynarAPIClient, Configuration } from '@neynar/nodejs-sdk';
import { uploadImageToIpfs, uploadMetadataToIpfs } from './ipfs_uploader.js';
import { ThirdwebSDK } from '@thirdweb-dev/sdk';
import { ethers } from 'ethers';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// ----------------------------------------------------
// 1. INITIALISIERUNG
// ----------------------------------------------------
const neynarConfig = new Configuration({ apiKey: process.env.NEYNAR_API_KEY });
const neynarClient = new NeynarAPIClient(neynarConfig);

const replicate = new Replicate({
    auth: process.env.REPLICATE_API_KEY
});

const wallet = new ethers.Wallet(process.env.WALLET_PRIVATE_KEY);

const MINT_CACHE = {}; 
const CONTRACT_ADDRESS = process.env.NFT_CONTRACT_ADDRESS; 
const BASE_SEPOLIA_CHAIN_ID = 84532;
const BASE_SEPOLIA_RPC_URL = process.env.BASE_SEPOLIA_RPC;


// ----------------------------------------------------
// 2. CORS FIX
// ----------------------------------------------------
const allowedOrigins = [
    "https://farcaster-box-frontend.vercel.app",
    "https://farcaster-box-frame.vercel.app"
];

const corsOptions = {
    origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error("Not allowed by CORS"));
        }
    },
    methods: ["GET", "POST"],
};

app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));


// ----------------------------------------------------
// 3. THIRDWEB INITIALISIERUNG
// ----------------------------------------------------
let sdkInstance = null;

async function getSDK() {
    if (sdkInstance) return sdkInstance;

    try {
        const provider = new ethers.providers.JsonRpcProvider(
            BASE_SEPOLIA_RPC_URL,
            BASE_SEPOLIA_CHAIN_ID
        );

        sdkInstance = new ThirdwebSDK(provider, {
            signer: wallet,
            secretKey: process.env.THIRDWEB_SECRET_KEY,
        });

        return sdkInstance;

    } catch (error) {
        console.error("[CRITICAL] SDK Init Fehlgeschlagen:", error.message);
        throw new Error("Blockchain SDK konnte nicht initialisiert werden.");
    }
}


// ----------------------------------------------------
// 4. HELPER: Farcaster PFP holen
// ----------------------------------------------------
async function getPfpUrl(fid) {
    try {
        // fid sicher in eine Zahl umwandeln
        const fids = [Number(fid)];

        // Neynar-SDK richtig aufrufen: Objekt mit { fids }
        const { users } = await neynarClient.fetchBulkUsers({ fids });

        const user = users && users[0];
        const pfpUrl = user?.pfp_url || null;

        if (!pfpUrl) {
            console.error("[ERROR] Kein PFP für FID gefunden:", fid);
        }

        return pfpUrl;
    } catch (error) {
        console.error(
            "[ERROR] PFP fetch fehlgeschlagen:",
            error.response?.data || error.message
        );
        return null;
    }
}


// ----------------------------------------------------
// 5. HELPER: KI / REPLICATE Bild generieren
// ----------------------------------------------------
async function generateBoxCharacter(pfpUrl) {
    const prompt = `
        A detailed 3D character portrait in the stylized box-shaped container style,
        thick black outlines, matte plastic, box figure, Funko Pop style,
        cute cyberpunk monkey, vibrant colors, digital art, centered, studio lighting.
    `;

    try {
        console.log("[LOG] Starte KI-Generierung bei Replicate (stable-diffusion)...");

        const output = await replicate.run(
            "stability-ai/stable-diffusion",   // sehr stabiles, öffentliches Modell
            {
                input: {
                    prompt: prompt
                    // wir lassen alle anderen Parameter auf Default:
                    // - Bildgröße
                    // - Steps
                    // - Guidance
                }
            }
        );

        // stable-diffusion gibt ein Array von Bild-URLs zurück
        if (Array.isArray(output) && output.length > 0) {
            return output[0];
        }

        console.error("[ERROR] KI Fehler: Keine Ausgabe erhalten.");
        return null;

    } catch (error) {
        console.error(
            "[ERROR] KI Fehler:",
            error.response?.data || error.message || error.toString()
        );
        return null;
    }
}

// ----------------------------------------------------
// 6. API: START GENERATION
// ----------------------------------------------------
app.post("/api/start-generation", async (req, res) => {
    const { fid } = req.body;

    if (!fid) {
        return res.status(400).json({ error: "Missing FID" });
    }

    if (MINT_CACHE[fid] && MINT_CACHE[fid].status !== "error") {
        return res.json({ status: MINT_CACHE[fid].status });
    }

    MINT_CACHE[fid] = { status: "processing" };

    res.json({
        status: "processing",
        message: "Generation started."
    });

    try {
        const pfpUrl = await getPfpUrl(fid);
        if (!pfpUrl) throw new Error("No PFP found.");

        const aiImage = await generateBoxCharacter(pfpUrl);
        if (!aiImage) throw new Error("AI generation failed.");

        const ipfsUri = await uploadImageToIpfs(aiImage, fid);
        if (!ipfsUri) throw new Error("IPFS failed.");

        const metadataUri = await uploadMetadataToIpfs(fid, ipfsUri);
        if (!metadataUri) throw new Error("Metadata failed.");

        MINT_CACHE[fid] = {
            status: "ready",
            metadataUri,
            ipfsUri
        };

        console.log(`[SUCCESS] FID ${fid} ready for mint.`);

    } catch (err) {
        console.error(`[CRITICAL] Fehler bei Generation FID ${fid}:`, err.message);
        MINT_CACHE[fid] = { status: "error", message: err.message };
    }
});


// ----------------------------------------------------
// 7. API: STATUS
// ----------------------------------------------------
app.get("/api/status", (req, res) => {
    const { fid } = req.query;

    if (!fid || !MINT_CACHE[fid]) {
        return res.status(404).json({ error: "No active job." });
    }

    res.json(MINT_CACHE[fid]);
});


// ----------------------------------------------------
// 8. API: MINT NFT
// ----------------------------------------------------
app.post("/api/mint-nft", async (req, res) => {
    const { fid, recipientAddress } = req.body;

    if (!fid || !recipientAddress) {
        return res.status(400).json({ error: "Missing parameters." });
    }

    const entry = MINT_CACHE[fid];

    if (!entry || entry.status !== "ready") {
        return res.status(409).json({ error: "Not ready to mint." });
    }

    const sdk = await getSDK().catch(() => null);
    if (!sdk) return res.status(500).json({ error: "Blockchain connection failed." });

    try {
        const contract = await sdk.getContract(CONTRACT_ADDRESS, "nft-collection");

        const tx = await contract.erc721.mint({
            to: recipientAddress,
            metadata: {
                name: `Box Character #${fid}`,
                description: "AI Box Character minted via Farcaster.",
                uri: entry.metadataUri
            }
        });

        delete MINT_CACHE[fid];

        return res.json({
            success: true,
            txHash: tx.receipt.transactionHash
        });

    } catch (error) {
        console.error("[ERROR] Minting failed:", error.message);
        return res.status(500).json({ error: "Mint failed.", details: error.message });
    }
});


// ----------------------------------------------------
// 9. SERVERLESS EXPORT (WICHTIG)
// ----------------------------------------------------
export default app;



