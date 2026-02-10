
// QOV Player Bridge
// Replaces player.ts for the C# Hybrid Implementation

let ws = null;
let canvas = null;
let ctx = null;

// UI Elements
const dropZone = document.getElementById('dropZone');
const timelineProgress = document.getElementById('timelineProgress'); // Not fully implemented in bridge yet
const playBtn = document.getElementById('playBtn');
const headerInfo = document.getElementById('headerInfo');

// We use "startBtn" style controls but ids are:
// playBtn, prevFrameBtn, nextFrameBtn, prevKeyframeBtn, nextKeyframeBtn
// fileInput

async function init() {
    canvas = document.getElementById('playerCanvas');
    ctx = canvas.getContext('2d');

    // Resize canvas initially
    canvas.width = 800; // default
    canvas.height = 600;

    connectWebSocket();

    // Events
    document.getElementById('dropZone').addEventListener('click', () => {
        // Send Open File Command
        ws.send(JSON.stringify({ type: "openFile" }));
    });

    playBtn.addEventListener('click', () => {
        const isPlaying = playBtn.textContent.includes('Pause');
        if (isPlaying) {
            ws.send("pause");
            playBtn.innerHTML = "&#9654; Play";
        } else {
            ws.send("play");
            playBtn.innerHTML = "&#10074;&#10074; Pause";
        }
    });

    // Seek/Step buttons can be implemented via commands
    // e.g. ws.send(JSON.stringify({type: "seek", frame: ...}))
}

function connectWebSocket() {
    ws = new WebSocket('ws://localhost:8000/player');
    ws.binaryType = 'arraybuffer';

    ws.onmessage = (event) => {
        if (typeof event.data === 'string') {
            const msg = JSON.parse(event.data);
            if (msg.type === 'meta') {
                // Video Loaded
                canvas.width = msg.width;
                canvas.height = msg.height;

                dropZone.style.display = 'none';
                playBtn.disabled = false;

                // Update Sidebar
                updateInfo('Resolution', `${msg.width} x ${msg.height}`);
                updateInfo('Frame Rate', `${msg.fps}`);
                updateInfo('Total Frames', msg.totalFrames || '-');
            } else if (msg.type === 'eof') {
                playBtn.innerHTML = "&#9654; Play";
            }
        } else {
            // Binary Frame Data (RGBA)
            const arrayBuffer = event.data;
            const uint8 = new Uint8ClampedArray(arrayBuffer);
            const imageData = new ImageData(uint8, canvas.width, canvas.height);
            ctx.putImageData(imageData, 0, 0);

            // We could update timeline here if we knew current frame index
        }
    };
}

function updateInfo(label, value) {
    // Simple helper to find the sidebar item by label text
    // The existing HTML structure is complex, let's just find by ID if possible
    // HTML has ids like "infoResolution"
    const idMap = {
        'Resolution': 'infoResolution',
        'Frame Rate': 'infoFrameRate',
        'Total Frames': 'infoTotalFrames',
        'Version': 'infoVersion',
        'Duration': 'infoDuration'
    };

    if (idMap[label]) {
        const el = document.getElementById(idMap[label]);
        if (el) el.textContent = value;
    }
}

init();
