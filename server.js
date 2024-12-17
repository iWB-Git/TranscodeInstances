const express = require("express");
const path = require("path");
const fs = require("fs");
const http = require("http");
const socketIO = require("socket.io");
const multer = require("multer");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegStatic = require("ffmpeg-static");
const ffprobeInstaller = require("@ffprobe-installer/ffprobe");
// Set the paths for FFmpeg and ffprobe
ffmpeg.setFfmpegPath(ffmpegStatic);
ffmpeg.setFfprobePath(ffprobeInstaller.path);
const app = express();
const server = http.createServer(app);
const io = socketIO(server);
const PORT = 8096;
const FormData = require("form-data");
const axios = require("axios");
const uploadFile = require("./uploadFile");
// Serve static files
app.use(express.static(path.join(__dirname, "out")));
app.use(express.json()); // For parsing JSON bodies
app.use(express.urlencoded({ extended: true })); // For parsing URL-encoded bodies

// Set up multer for file uploads
const upload = multer({ dest: "uploads/" });

// Transcoding endpoint
app.post("/api/transcode/:fileName", upload.single("video"), (req, res) => {
  try{
  const accessToken=""
  const inputFilePath = `uploads/${req.params.fileName}`;
  console.log(inputFilePath);
  const outputFilePath = path.join(__dirname, "transcoded");

  const resolutions = [
    ["1920:1080", "5000k"],
    ["1280:720", "3000k"],
    ["640:360", "1000k"],
  ];

  const clientId = req.headers["socket-id"];
  const clientSocket = io.sockets.sockets.get(clientId);

  if (!clientSocket) {
    return res.status(400).json({ error: "Socket connection not found." });
  }

  if (!fs.existsSync(outputFilePath)) {
    fs.mkdirSync(outputFilePath, { recursive: true });
  }

  const split = resolutions.length;
  let filterComplex = `[0:v]split=${split}`;
  const filters = [];
  resolutions.forEach(([resolution, bitrate], index) => {
    filterComplex += `[v${index + 1}]`;
  });
  filterComplex += ";";

  resolutions.forEach(([resolution], index) => {
    filterComplex += `[v${index + 1}]scale=${resolution}[v${index + 1}out];`;
  });

  const command = ffmpeg(inputFilePath)
    .inputOptions(["-filter_complex", filterComplex])
    .outputOptions(["-preset fast", "-g 120", "-sc_threshold 0"]);

  const segmentMap = new Map();
  resolutions.forEach(([resolution, bitrate], index) => {
    const height = resolution.split(":")[1];
    command
      .output(path.join(outputFilePath, `${height}p.m3u8`))
      .outputOptions([
        `-map [v${index + 1}out]`,
        `-map 0:a`,
        `-c:v:${index} hevc_nvenc`,
        `-b:v:${index} ${bitrate}`,
        `-c:a:${index} aac`,
        `-b:a:${index} 192k`,
        `-hls_time 7`,
        `-hls_playlist_type vod`,
        `-hls_segment_filename ${path.join(
          outputFilePath,
          `${height}p_%03d.ts`
        )}`,
      ]);
  });

  command
  .on("stderr", (stderrLine) => {
    const match = stderrLine.match(/Opening '.*?(\d+p_\d+\.ts)' for writing/);
    if (match) {
      const currentFile = match[1];
      //split currentFile
      const fileName = currentFile.replace('.ts', '');
      const [res, segment] = fileName.split('_');

      // Calculate the past file segment (segment - 1)
      const pastSegment = segmentMap.get(res);
      segmentMap.set(res,segment)
      if(!pastSegment){
        return;
      }
      const pastFile = `${res}_${pastSegment}.ts`;
      console.log(pastFile)
      const filePath = path.join(outputFilePath, pastFile);
      
      
      // Send the file to the Deno server
      uploadFile(filePath,pastFile,accessToken);
    
      

      clientSocket.emit("transcode-progress", { file: currentFile });
    }
  })
  .on("start", (cmd) => {
    console.log("FFmpeg command:", cmd);
    clientSocket.emit("transcode-progress", { percent: 0 }); // Emit initial progress
  })
  .on("progress", (progress) => {
    clientSocket.emit("transcode-progress", { percent: progress.percent });
  })
  .on("end", () => {
    //itterate through map
    segmentMap.forEach((value,key)=>{
      const lastSegment = `${key}_${value}.ts`;
      const manifest=`${key}.m3u8`
      const segmentPath = path.join(outputFilePath, lastSegment);
      const manifestPath=path.join(outputFilePath, manifest);
      uploadFile(segmentPath,lastSegment,accessToken)
      uploadFile(manifestPath,manifest,accessToken)
    })
    clientSocket.emit("transcode-complete"); // Emit completion event
  })
    .on("error", (err) => {
      console.error("Error during transcoding:", err.message);
      clientSocket.emit("transcode-error"); // Emit error event
    })
    .run();

  // Respond only once
  res.json({ message: "Transcoding started.", outputPath: outputFilePath });
  }catch(error){
    console.log(error.message)
  }
  
});

app.post("/api/probe", upload.single("video"), (req, res) => {
  const inputFilePath = req.file.path;
  const fileName = inputFilePath.split("\\").pop();
  console.log(fileName);
  // Check if the file exists
  if (!fs.existsSync(inputFilePath)) {
    return res.status(400).json({ error: "File not found." });
  }

  // Use ffmpeg's probe method to get the details of the video
  ffmpeg.ffprobe(inputFilePath, (err, metadata) => {
    if (err) {
      console.error("Error probing the video:", err.message);
      return res.status(500).json({ error: "Error probing the video." });
    }

    // Extract relevant details from the probe metadata
    const videoStream = metadata.streams.find(
      (stream) => stream.codec_type === "video"
    );
    const audioStream = metadata.streams.find(
      (stream) => stream.codec_type === "audio"
    );

    const videoDetails = {
      resolution: videoStream
        ? `${videoStream.width}x${videoStream.height}`
        : "Unknown",
      bitrate: videoStream ? videoStream.bit_rate : "Unknown",
      codec: videoStream ? videoStream.codec_name : "Unknown",
    };

    const audioDetails = {
      bitrate: audioStream ? audioStream.bit_rate : "Unknown",
      codec: audioStream ? audioStream.codec_name : "Unknown",
    };

    // Respond with the video and audio details
    res.json({
      video: videoDetails,
      audio: audioDetails,
      duration: metadata.format.duration,
      format: metadata.format.format_name,
      file: inputFilePath,
    });
  });
});

// Catch-all route for the frontend
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "out", "index.html"));
});

// Start server
server.listen(PORT, () => {
  console.log(`App running on http://localhost:${PORT}`);
});

// Socket.IO connection
io.on("connection", (socket) => {
  console.log("Client connected.");
  socket.on("disconnect", () => {
    console.log("Client disconnected.");
  });
});
