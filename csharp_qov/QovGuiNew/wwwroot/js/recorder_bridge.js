
// QOV Recorder Bridge
// Replaces recorder.ts for the C# Hybrid Implementation

let mediaStream = null;
let ws = null;
let isRecording = false;
let canvas = null;
let ctx = null;
let frameInterval = null;
let startTime = 0;
let frameCount = 0;
let keyframes = 0;
let totalBytes = 0;

// UI Elements
const preview = document.getElementById('preview');
const startBtn = document.getElementById('startBtn');
const cameraSelect = document.getElementById('cameraSelect');
const resolutionSelect = document.getElementById('resolutionSelect');
const fpsSelect = document.getElementById('fpsSelect');
// const keyframeIntervalSelect = document.getElementById('keyframeInterval'); // Passed to C#? Or handled by C#? C# Service handles encoding.
// For now, we just stream raw frames. We can pass params in Start command.

async function init() {
    canvas = document.getElementById('captureCanvas');
    ctx = canvas.getContext('2d', { willReadFrequently: true });

    // Populate cameras
    await getCameras();

    // Connect WebSocket
    connectWebSocket();

    // Photino Message Handler
    window.external.receiveMessage(message => {
        if (message.startsWith("savedFile:")) {
            const path = message.substring(10);
            startRecordingWithPath(path);
        }
    });

    // Event Listeners
    startBtn.addEventListener('click', toggleRecording);
    cameraSelect.addEventListener('change', startCamera);
    resolutionSelect.addEventListener('change', startCamera);
    fpsSelect.addEventListener('change', startCamera);

    // Add Screen Share option to camera select
    const screenOpt = document.createElement('option');
    screenOpt.value = 'screen';
    screenOpt.text = 'Screen Capture';
    cameraSelect.appendChild(screenOpt);

    // Initial camera start
    startCamera();
}

async function getCameras() {
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoDevices = devices.filter(device => device.kind === 'videoinput');

        cameraSelect.innerHTML = '';
        videoDevices.forEach(device => {
            const option = document.createElement('option');
            option.value = device.deviceId;
            option.text = device.label || `Camera ${cameraSelect.length + 1}`;
            cameraSelect.appendChild(option);
        });

        // Add Screen Share again if cleared
        const screenOpt = document.createElement('option');
        screenOpt.value = 'screen';
        screenOpt.text = 'Screen Capture';
        cameraSelect.appendChild(screenOpt);
    } catch (e) {
        console.error("Error enumerating devices:", e);
    }
}

async function startCamera() {
    if (mediaStream) {
        mediaStream.getTracks().forEach(track => track.stop());
    }

    const deviceId = cameraSelect.value;
    const [width, height] = resolutionSelect.value.split('x').map(Number);
    const fps = parseInt(fpsSelect.value);

    const constraints = {
        video: {
            width: { ideal: width },
            height: { ideal: height },
            frameRate: { ideal: fps }
        },
        audio: false // Audio not supported in this bridge version yet?
    };

    if (deviceId === 'screen') {
        try {
            mediaStream = await navigator.mediaDevices.getDisplayMedia({
                video: { width: width, height: height, frameRate: fps }
            });
        } catch (e) {
            console.error("Screen capture error:", e);
            return;
        }
    } else {
        if (deviceId) {
            constraints.video.deviceId = { exact: deviceId };
        }
        try {
            mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
        } catch (e) {
            console.error("Camera error:", e);
        }
    }

    preview.srcObject = mediaStream;

    // Update canvas size
    const settings = mediaStream.getVideoTracks()[0].getSettings();
    canvas.width = settings.width || width;
    canvas.height = settings.height || height;

    startBtn.disabled = false;
}

function connectWebSocket() {
    ws = new WebSocket('ws://localhost:8000/record');
    ws.binaryType = 'arraybuffer';

    ws.onopend = () => {
        console.log("Connected to Recorder Service");
        startBtn.disabled = false;
    };

    ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'saved') {
            alert(`Saved to: ${msg.path}`);
            resetStats();
        } else if (msg.type === 'error') {
            alert(`Error: ${msg.message}`);
            stopRecordingInternal();
        }
    };

    ws.onclose = () => {
        console.log("Disconnected");
        setTimeout(connectWebSocket, 1000);
    };
}

async function toggleRecording() {
    if (!isRecording) {
        // Start Recording -> Ask for File First
        window.external.sendMessage("saveFile");
    } else {
        // Stop Recording
        stopRecordingInternal();
    }
}

function startRecordingWithPath(path) {
    // Prepare Start Command
    const settings = mediaStream.getVideoTracks()[0].getSettings();

    // Get Settings
    const keyframePeriod = parseInt(document.getElementById('keyframeInterval').value) || 30;
    const colorspace = parseInt(document.getElementById('colorspaceSelect').value) || 0x10; // Default YUV420
    const mode = document.getElementById('encodingMode').value;
    let quality = 0;

    if (mode === 'lossy') {
        quality = parseInt(document.getElementById('qualitySlider').value) || 75;
    } else if (mode === 'custom') {
        // Custom not fully supported in bridge command yet, falling back to quality 0 (lossless) or specific params if added
        // For now let's map custom to a quality default or handle explicit params later
        quality = 50; // placeholder
    }

    const startCmd = {
        type: "start",
        path: path,
        width: canvas.width,
        height: canvas.height,
        fps: parseInt(fpsSelect.value),
        keyframePeriod: keyframePeriod,
        colorspace: colorspace,
        encodingMode: mode,
        quality: quality
    };

    ws.send(JSON.stringify(startCmd));

    isRecording = true;
    startBtn.textContent = "Stop Recording";
    startBtn.classList.add('recording');

    startTime = Date.now();
    frameCount = 0;

    // Start Loop
    const interval = 1000 / startCmd.fps;
    frameInterval = setInterval(processFrame, interval);

    document.getElementById('recordingIndicator').classList.add('active');
}

function stopRecordingInternal() {
    isRecording = false;
    clearInterval(frameInterval);
    startBtn.textContent = "Start Recording";
    startBtn.classList.remove('recording');
    document.getElementById('recordingIndicator').classList.remove('active');

    ws.send(JSON.stringify({ type: "stop" }));
}

function processFrame() {
    if (!isRecording) return;

    ctx.drawImage(preview, 0, 0, canvas.width, canvas.height);

    // Get Raw Data
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    // imageData.data is Uint8ClampedArray (RGBA)

    // Send to WebSocket
    // We can send raw bytes. C# expects it.
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(imageData.data); // Sends binary frame

        // Update Stats
        frameCount++;
        totalBytes += imageData.data.byteLength; // Rough estimate of RAW flow, not file size
        updateStats();
    }
}

function updateStats() {
    const dur = (Date.now() - startTime) / 1000;
    document.getElementById('statDuration').textContent = formatTime(dur);
    document.getElementById('statFrames').textContent = frameCount;
    // document.getElementById('statSize').textContent = ... // C# should send back size updates ideally
}

function formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
}

function resetStats() {
    document.getElementById('statDuration').textContent = "0:00";
    document.getElementById('statFrames').textContent = "0";
}

// Initialize
init();
