import axios from 'axios';
import FormData from 'form-data';
import dotenv from 'dotenv';
dotenv.config();

async function uploadImageToIpfs(imageUrl, fid) {
    if (!imageUrl) return null;

    try {
        const imageResponse = await axios.get(imageUrl, { responseType: 'arraybuffer' });
        const imageBuffer = Buffer.from(imageResponse.data);

        const data = new FormData();
        data.append('file', imageBuffer, {
            filepath: `box_charakter_fid_${fid}.png`,
        });

        const pinataResponse = await axios.post(
            'https://api.pinata.cloud/pinning/pinFileToIPFS',
            data,
            {
                maxBodyLength: Infinity,
                headers: {
                    ...data.getHeaders(),
                    'pinata_api_key': process.env.PINATA_API_KEY,
                    'pinata_secret_api_key': process.env.PINATA_SECRET_KEY,
                },
            }
        );

        return `ipfs://${pinataResponse.data.IpfsHash}`;
    } catch (error) {
        console.error("IPFS ERROR:", error.response?.data || error.message);
        return null;
    }
}

async function uploadMetadataToIpfs(fid, ipfsImageUri) {
    const metadata = {
        name: `Box Character #${fid}`,
        description: `AI-generated Box Character NFT for Farcaster user FID ${fid}`,
        image: ipfsImageUri,
        attributes: [
            { trait_type: "Creator Platform", value: "Farcaster Frame" },
            { trait_type: "Style", value: "Box Character" },
            { trait_type: "FID", value: fid.toString() }
        ]
    };

    try {
        const pinataResponse = await axios.post(
            'https://api.pinata.cloud/pinning/pinJSONToIPFS',
            metadata,
            {
                headers: {
                    'Content-Type': 'application/json',
                    'pinata_api_key': process.env.PINATA_API_KEY,
                    'pinata_secret_api_key': process.env.PINATA_SECRET_KEY,
                },
            }
        );

        return `ipfs://${pinataResponse.data.IpfsHash}`;
    } catch (error) {
        console.error("IPFS META ERROR:", error.response?.data || error.message);
        return null;
    }
}

export { uploadImageToIpfs, uploadMetadataToIpfs };
