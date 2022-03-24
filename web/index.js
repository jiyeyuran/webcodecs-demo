const params = new URLSearchParams(location.search);
const autoStart = params.has("autoStart");
const appId = params.get("appId") || document.getElementById("appId").value;
const roomId = params.get("roomId") || document.getElementById("roomId").value;
const userId = params.get("userId") || document.getElementById("userId").value;
const userToken = params.get("userToken") || document.getElementById("userToken").value;

if (autoStart) {
  start();
}

// 视频配置
let fps = 25;
let videoCodecType = "avc1.42e01f"; // vp8, vp09.00.10.08, av1.xx
let videoCodecFormat = "annexb"; // avc
let videoGopSize = fps * 5;
let videoBitrate = 2_000_000;
let encodedFrames = 0;
let userLastFrameStayDuration = 3000;
let vencoder;

// 音频配置
let audioContext = autoStart ? new OfflineAudioContext() : new AudioContext();
let audioDest = audioContext.createMediaStreamDestination();
let audioCodec = "opus";
let audioChannels = 2;
let audioSampleRate = 48000;
let aencoder;

// canvas配置
var canvasWidth = 640;
var canvasHeight = 480;
var canvas = autoStart
  ? new OffscreenCanvas()
  : document.getElementById("canvas");
var context = canvas.getContext("2d");
canvas.width = canvasWidth;
canvas.height = canvasHeight;

var client = VRTC.createClient({});
var vframes = [];
var started = false;
var layouts = new Map();
var mixStarted = false;
var mixedVideoTrack;
var mixedAudioTrack;
var canvasTimer;
var ws;
var mux;
var startAt;

function ready() {
  console.log("ready");
  client.join(userToken, roomId, userId, onJoined, (err) => alert(`${err}`));
}

function onJoined(uid) {
  console.log("joined", uid);
  client.on("stream-added", handleStreamAdd);
  client.on("stream-subscribed", handlelayoutsubscribed);
  client.on("stream-removed", handleStreamRemove);
}

function handleStreamAdd(event) {
  client.subscribe(event.stream);
}

async function handlelayoutsubscribed(event) {
  const stream = event.stream;

  // fix: the subscribed stream event notified twice
  if (layouts.has(stream.getId())) {
    return;
  }

  layouts.set(stream.getId(), { lastFrameTime: 0 });
  updateLayout(layouts);

  console.log("stream subscribed", stream.getId());

  const videoTrack = stream.getVideoTrack();

  if (videoTrack) {
    readVideoFrame(stream.getId(), videoTrack);
  }

  const audioTrack = stream.getAudioTrack();

  if (audioTrack) {
    // fix issue: https://bugs.chromium.org/p/chromium/issues/detail?id=933677
    const audioStream = new MediaStream([audioTrack]);
    const a = new Audio();
    a.srcObject = audioStream; // this workarounds the issue

    readAudioFrame(audioTrack);
  }

  if (!mixStarted) {
    mixStarted = true;
    console.log("mix started");

    canvasTimer = setInterval(drawCanvas, 1000 / fps);

    mixedAudioTrack = audioDest.stream.getAudioTracks()[0];
    mixedVideoTrack = canvas.captureStream(fps).getVideoTracks()[0];

    encodeMixedAudio(mixedAudioTrack);
    encodeMixedVideo(mixedVideoTrack);
  }
}

function handleStreamRemove(event) {
  layouts.delete(event.stream.getId());
  updateLayout(layouts);
}

function drawCanvas() {
  vframes.forEach((record) => {
    const layout = layouts.get(record.streamId);
    if (layout) {
      layout.lastFrameTime = Date.now();
      context.drawImage(
        record.frame,
        layout.x,
        layout.y,
        layout.width,
        layout.height
      );
    }
    record.frame.close();
  });

  vframes = [];

  Array.from(layouts.values()).forEach((layout) => {
    if (Date.now() - layout.lastFrameTime > userLastFrameStayDuration) {
      context.fillStyle = "#ff0000";
      context.fillRect(layout.x, layout.y, layout.width, layout.height);
    }
  });

  //   createImageBitmap(canvas).then((bmp) => {
  //     let videoFrame = new VideoFrame(bmp, {
  //       // timestamp: (1000 / fps) * encodedFrames++,
  //       timestamp: Date.now(),
  //     });
  //     vencoder.encode(videoFrame);
  //     videoFrame.close();
  //   });
}

function updateLayout(layouts) {
  const num = layouts.size;
  let rows = Math.ceil(Math.sqrt(num));
  let cols = rows;

  if (num <= 2) {
    rows = 1;
  }

  const width = parseInt(canvasWidth / cols, 10);
  const height = parseInt(canvasHeight / rows, 10);

  Array.from(layouts.values()).forEach((layout, i) => {
    const x = width * (i % cols);
    const y = height * (i % rows);

    layout.x = width * (i % cols);
    layout.y = height * (i % rows);
    layout.width = width;
    layout.height = height;
  });
}

async function readAudioFrame(audioTrack) {
  const processor = new MediaStreamTrackProcessor(audioTrack);
  const reader = processor.readable.getReader();

  while (true) {
    const result = await reader.read();

    if (result.done) {
      break;
    }

    const audioData = result.value;
    const source = audioContext.createBufferSource();
    source.buffer = new AudioBuffer({
      length: audioData.numberOfFrames,
      numberOfChannels: audioData.numberOfChannels,
      sampleRate: audioData.sampleRate,
    });
    for (let i = 0; i < audioData.numberOfChannels; i++) {
      audioData.copyTo(source.buffer.getChannelData(i), {
        planeIndex: i,
        frameOffset: 0,
        frameCount: audioData.numberOfFrames,
        format: audioData.format,
      });
    }
    source.connect(audioDest);
    source.start();
    audioData.close();
  }
}

async function readVideoFrame(streamId, videoTrack) {
  const processor = new MediaStreamTrackProcessor(videoTrack);
  const reader = processor.readable.getReader();

  while (true) {
    const result = await reader.read();

    if (result.done) {
      break;
    }

    const frame = result.value;
    vframes.push({ streamId, frame });
  }
}

async function encodeMixedAudio(audioTrack) {
  const processor = new MediaStreamTrackProcessor({ track: audioTrack });
  const reader = processor.readable.getReader();

  while (true) {
    const result = await reader.read();

    if (result.done) {
      break;
    }

    const frame = result.value;

    aencoder.encode(frame);

    frame.close();
  }
}

async function encodeMixedVideo(videoTrack) {
  const processor = new MediaStreamTrackProcessor({ track: videoTrack });
  const reader = processor.readable.getReader();

  while (true) {
    const result = await reader.read();

    if (result.done) {
      break;
    }

    const frame = result.value;

    vencoder.encode(frame, { keyFrame: encodedFrames++ % videoGopSize === 0 });

    frame.close();
  }
}

function handleVideoEncoded(chunk, metadata) {
  const chunkData = new Uint8Array(chunk.byteLength);
  chunk.copyTo(chunkData);

  let ts = chunk.timestamp / 1000;

  if (metadata.decoderConfig) {
    const avcSeqHdr = metadata.decoderConfig.description;
    if (avcSeqHdr) {
      if (mux) {
        mux.DoMux({
          media: "video",
          codecType: videoCodecType,
          timestamp: ts,
          data: avcSeqHdr,
          isSeq: true,
          isKey: false,
        });
      } else {
        sendData(avcSeqHdr);
      }
    }
  }

  let isKey = chunk.type == "key";

  if (isKey) {
    console.log("frame", chunk.type, Date.now() / 1000);
  } else {
    console.log("frame", chunk.type);
  }

  if (mux) {
    mux.DoMux({
      media: "video",
      codecType: videoCodecType,
      timestamp: ts,
      data: chunkData,
      isSeq: false,
      isKey,
    });
  } else {
    sendData(chunkData);
  }
}

function handleAudioEncoded(chunk, metadata) {
  const chunkData = new Uint8Array(chunk.byteLength);
  chunk.copyTo(chunkData);

  //   sendData(chunkData);
}

function initMux(ws) {
  mux = new FlvMux();
  mux.SetWriter(ws);
  mux.Init(true, false);
}

function sendData(data) {
  if (ws && ws.readyState === WebSocket.OPEN && !mux) {
    ws.send(data);
  }
}

async function start() {
  vencoder = new VideoEncoder({
    output: handleVideoEncoded,
    error: (error) => {
      console.error("video encoder error:" + error);
    },
  });
  const config = {
    codec: videoCodecType,
    width: canvasWidth,
    height: canvasHeight,
    bitrate: videoBitrate,
    framerate: fps,
    hardwareAcceleration: "prefer-software",
    latencyMode: "quality",
  };
  if (videoCodecType.startsWith("avc1.")) {
    config.avc = { format: videoCodecFormat };
  }
  await vencoder.configure(config);

  aencoder = new AudioEncoder({
    output: handleAudioEncoded,
    error: (error) => {
      console.error("audio encoder error:" + error);
    },
  });
  await aencoder.configure({
    codec: audioCodec,
    numberOfChannels: audioChannels,
    sampleRate: audioSampleRate,
  });

  ws = new WebSocket("ws://" + location.host + "/ws");
  ws.onopen = () => {
    console.log("websocket opened");
    initMux(ws);
    client.init(appId, () => {
      client.join(userToken, roomId, userId, onJoined, (err) =>
        alert(`${err}`)
      );
    });
  };
  ws.onclose = () => {
    console.log("websocket closed");
  };

  startAt = Date.now();
}

async function stop() {
  await client.leave();

  if (mixedVideoTrack) {
    mixedVideoTrack.stop();
  }
  if (mixedAudioTrack) {
    mixedAudioTrack.stop();
  }

  if (canvasTimer) {
    clearInterval(canvasTimer);
  }

  await aencoder.flush();
  await vencoder.flush();

  aencoder.close();
  vencoder.close();

  layouts.clear();

  ws.close();

  console.log("stop", (Date.now() - startAt) / 1000);
}

document.getElementById("control").addEventListener("click", async (e) => {
  if (started) {
    started = false;
    e.target.innerText = "开始";
    e.target.disabled = true;
    await stop();
  } else {
    await start();
    started = true;
    e.target.innerText = "结束";
  }
});
