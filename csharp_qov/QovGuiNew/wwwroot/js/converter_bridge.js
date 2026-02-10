
// QOV Converter Bridge
// Replaces converter.ts for the C# Hybrid Implementation

let ws = null;
let video = document.createElement('video');
let canvas = null;
let ctx = null;
let isConverting = false;
let totalFrames = 0;
let currentFrame = 0;
let inputPath = "";
let outputPath = "";

// UI Elements
const previewCanvas = document.getElementById('previewCanvas');
const convertBtn = document.getElementById('convertBtn');
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
// Settings
const fpsSelect = document.getElementById('targetFps');
const resolutionSelect = document.getElementById('resolution');

async function init() {
    canvas = document.createElement('canvas'); // Offscreen for processing
    ctx = canvas.getContext('2d', { willReadFrequently: true });

    // Preview canvas context
    const pCtx = previewCanvas.getContext('2d');

    connectWebSocket();

    // Event Listeners
    dropZone.addEventListener('click', () => {
        // Trigger Open File Dialog via C#
        ws.send(JSON.stringify({ type: "selectInput" }));
    });

    convertBtn.addEventListener('click', () => {
        // Trigger Save File Dialog via C# -> Then start
        ws.send(JSON.stringify({ type: "selectOutput" }));
    });
}

function connectWebSocket() {
    ws = new WebSocket('ws://localhost:8000/converter');
    ws.binaryType = 'arraybuffer';

    ws.onmessage = async (event) => {
        const msg = JSON.parse(event.data);

        if (msg.type === 'inputSelected') {
            inputPath = msg.path;
            loadVideo(inputPath); // Only works if browser can access file path directly?
            // Browser cannot access local file by path due to security!
            // Wait. "Hybrid" app. Photino uses WebView2/Chromium.
            // Local file access might be allowed if we use file:// protocol. 
            // The C# server loads index.html from disk.
            // Let's try setting video.src = "file:///" + path;
            // If that fails, we might need C# to stream the video file to us via an http endpoint.

            // For now, let's assume direct file access works in Photino for local files?
            // Photino docs say "WebView2 can access local files if...".
            // If not, we need a local webserver to serve the file.
            // Our WebSocketServer is at localhost:8000. We might need to add a file handler there.

            // Temporary fix attempt:
            video.src = "file:///" + inputPath.replace(/\\/g, '/');
            dropZone.querySelector('.drop-zone-text').textContent = inputPath;

        } else if (msg.type === 'outputSelected') {
            outputPath = msg.path;
            startConversion();
        } else if (msg.type === 'progress') {
            // update UI
        }
    };
}

function loadVideo(path) {
    video.src = "file:///" + path.replace(/\\/g, '/');
    video.onloadedmetadata = () => {
        updateStats();
        convertBtn.disabled = false;
        dropZone.style.display = 'none';

        previewCanvas.width = video.videoWidth;
        previewCanvas.height = video.videoHeight;
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;

        // Draw first frame
        video.currentTime = 0;
    };
    video.onerror = (e) => {
        console.error("Error loading video", e);
        alert("Could not load video. Browser might restrict local file access.");
    };
}

async function startConversion() {
    if (isConverting) return;
    isConverting = true;
    convertBtn.disabled = true;

    // Send Start Command
    const fps = parseInt(fpsSelect.value) || 30; // 0 = keep original, need logic

    ws.send(JSON.stringify({
        type: "start",
        path: outputPath,
        width: canvas.width,
        height: canvas.height,
        fps: fps
    }));

    // Start Loop
    const duration = video.duration;
    const interval = 1.0 / fps;
    let time = 0;

    // We use a "seek and snap" approach
    // Note: seeking is slow. 

    const processFrame = async () => {
        if (time >= duration) {
            finishConversion();
            return;
        }

        video.currentTime = time;

        // Wait for seek
        await new Promise(r => {
            const onSeek = () => {
                video.removeEventListener('seeked', onSeek);
                r();
            };
            video.addEventListener('seeked', onSeek);
        });

        // Capture
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

        // Send
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(imageData.data);
        }

        // Preview
        const pCtx = previewCanvas.getContext('2d');
        pCtx.drawImage(canvas, 0, 0, previewCanvas.width, previewCanvas.height);

        // Next
        time += interval;
        requestAnimationFrame(processFrame);
    };

    processFrame();
}

function finishConversion() {
    isConverting = false;
    convertBtn.disabled = false;
    convertBtn.textContent = "Conversion Complete";
    ws.send(JSON.stringify({ type: "finish" }));
}

function updateStats() {
    document.getElementById('statFileName').textContent = inputPath.split(/[/\\]/).pop();
    document.getElementById('statResolution').textContent = `${video.videoWidth}x${video.videoHeight}`;
    document.getElementById('statDuration').textContent = `${video.duration.toFixed(2)}s`;
}

init();
