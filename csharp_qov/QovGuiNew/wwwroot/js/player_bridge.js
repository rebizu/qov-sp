
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

    // Photino Message Handler
    window.external.receiveMessage(message => {
        if (message.startsWith("opened:")) {
            // C# loaded the file. We can now expect metadata from WebSocket
            waitForWsAndSend({ type: "openFile" });
        }
    });

    // Events
    document.getElementById('dropZone').addEventListener('click', () => {
        // Send Open File Command to Photino
        window.external.sendMessage("openFile");
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
    ws = new WebSocket('ws://localhost:8000/play');
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
                updateInfo('Magic', 'QOV');
                updateInfo('Resolution', `${msg.width} x ${msg.height}`);
                updateInfo('Frame Rate', `${msg.fps}`);
                updateInfo('Total Frames', msg.totalFrames || '-');
                updateInfo('Version', `v${msg.version}`);
                updateInfo('Colorspace', msg.colorspace);
                updateInfo('Flags', `0x${msg.flags.toString(16).toUpperCase()}`);

                if (msg.fileSize) {
                    const mb = (msg.fileSize / (1024 * 1024)).toFixed(2);
                    updateInfo('File Size', `${mb} MB`);
                }

                if (msg.totalFrames && msg.fps) {
                    const dur = msg.totalFrames / msg.fps;
                    const min = Math.floor(dur / 60);
                    const sec = Math.floor(dur % 60);
                    updateInfo('Duration', `${min}:${sec.toString().padStart(2, '0')}`);
                }

                // Clear chunk list on new file load
                const cl = document.getElementById('chunkList');
                if (cl) cl.innerHTML = '<div style="color: #64748b; font-size: 0.85rem;">Load a QOV file to see chunks</div>';

            } else if (msg.type === 'frame') {
                updateInfo('Current Frame', msg.num);
                updateInfo('Timestamp', `${msg.ts}ms`);
                updateInfo('Frame Type', msg.ftype);
            } else if (msg.type === 'chunk') {
                // Add to Chunk Timeline
                const chunkList = document.getElementById('chunkList');
                if (chunkList.children.length > 0 && chunkList.children[0].innerText.startsWith("Load a")) {
                    chunkList.innerHTML = "";
                }

                // Limit list size to avoid DOM overload?
                if (chunkList.children.length > 50) {
                    chunkList.removeChild(chunkList.firstChild);
                }

                const item = document.createElement('div');
                // Determine class based on typeName
                let typeClass = "";
                if (msg.typeName === "KEYFRAME") typeClass = "keyframe";
                else if (msg.typeName === "PFRAME") typeClass = "pframe";
                else if (msg.typeName === "AUDIO") typeClass = "audio";
                else if (msg.typeName === "SYNC") typeClass = "sync";

                item.className = `chunk-item ${typeClass}`;
                item.innerHTML = `
                    <div class="chunk-type">${msg.typeName}</div>
                    <div class="chunk-offset">@${msg.offset}</div>
                    <div class="chunk-size">${msg.size}b</div>
                `;
                chunkList.appendChild(item);
                chunkList.scrollTop = chunkList.scrollHeight;

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
        'Magic': 'infoMagic',
        'Version': 'infoVersion',
        'Resolution': 'infoResolution',
        'Frame Rate': 'infoFrameRate',
        'Total Frames': 'infoTotalFrames',
        'Duration': 'infoDuration',
        'File Size': 'infoFileSize',
        'Colorspace': 'infoColorspace',
        'Flags': 'infoFlags',
        'Current Frame': 'infoCurrentFrame',
        'Frame Type': 'infoFrameType',
        'Timestamp': 'infoTimestamp',
        'Decode FPS': 'infoDecodeFps'
    };

    if (idMap[label]) {
        const el = document.getElementById(idMap[label]);
        if (el) el.textContent = value;
    }
}


function waitForWsAndSend(msgObj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msgObj));
    } else {
        console.log("WS not ready, retrying...");
        setTimeout(() => waitForWsAndSend(msgObj), 100);
    }
}

init();
