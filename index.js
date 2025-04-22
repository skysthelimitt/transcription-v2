// code developed off of documentation from groq and express
// https://console.groq.com/docs/openai
// https://expressjs.com/en/starter/hello-world.html

// file uploading handled by the multer npm project
// https://www.npmjs.com/package/multer

// initialize all of our dependencies
// dotenv quickly loads our environment variables.
import 'dotenv/config'
// express handles running a web server.
import express from 'express';
// multer handles file uploads.
import multer from 'multer';
// use the shell syntax and the random uuid generator from bun
// requires bun installed, rather than nodejs.
import { $, randomUUIDv7 } from 'bun';
// use the node:fs module, as bun's file system is not fully complete.
import fs from "node:fs";
// allows us to communicate with an openai compatible api.
import OpenAI from "openai";

// initialize our client, using the api key and url specified in our .env file.
const client = new OpenAI({
  apiKey: process.env.API_KEY,
  baseURL: process.env.OPENAI_API_URL,
});

// initialize our multer config.
const handleUpload = multer({ dest: './tmp/' })

// initialize directories & clear old temp
fs.rmSync("./tmp/", { recursive: true })
fs.mkdirSync("./tmp/");
fs.mkdirSync("./tmp/processed/");

// create the express app and static file setup.
const app = express();
const port = process.env.PORT || 3000;
app.use(express.static('public'));

app.post("/upload", handleUpload.single("audio"), async (req, res, next) => {
  // firstly, we check if the uploaded file contains any audio
  // this allows users to upload video files as well, and use any format supported by ffmpeg
  // which is how we will convert the audio into something supported by our speech to text model
  let isAudio;
  try {
    // this command is designed to just return 'audio' if it contains an audio stream.
    // uses a ternary operator to make the code one line.
    // uses bun's shell feature to use ffprobe directly.
    isAudio = ((await $`${process.env.FFPROBE_BINARY} -loglevel error -select_streams a -show_entries stream=codec_type -of csv=p=0 ${req.file.path}`.text()).includes("audio")) ? true : false;
  } catch (err) {
    // any error most likely means the file will not work in ffmpeg in the first place, safe to fail
    isAudio = false;
  }
  if(isAudio) {
    try {
      // the first step is converting into our desired format.
      // the ogg format is the best for audio compression
      // since the user will most likely have an hour+ long audio files, we want to make the file as small as possible
      // alongside that, this is the recommended ffmpeg command as of the groq documentation, which is what is used in testing.
      await $`${process.env.FFMPEG_BINARY} -i ${req.file.path} -ar 16000 -ac 1 -map 0:a -c:a libvorbis tmp/processed/${req.file.filename}.ogg`;
      // now that we have processed the file, we send it to our specified openai client to be transcribed.
      let transcription = await client.audio.transcriptions.create({
        file: fs.createReadStream(`tmp/processed/${req.file.filename}.ogg`),
        model: process.env.TRANSCRIPTION_MODEL
      });
      // we send the transcription in order to be summarized by another ai model.
      let summary = await client.chat.completions.create({
        model: process.env.SUMMARIZATION_MODEL,
        messages: [
          {
            role: "system",
            content: "You are a highly skilled summarization engine. Your sole task is to analyze the provided text, which is a transcription of a lesson, and produce a concise summary. The summary should capture the main topics, key concepts, and essential information presented in the lesson. Eliminate conversational filler, digressions, and minor points. Provide only the summary text. Do not use any markdown characters or formatting in your output. Present the summary as plain text.",
          },
          {
            role: "user",
            content: transcription.text,
          },
        ],
        temperature: 0.3,
      });
      // here is where we create the final entry for all of our data.
      // we generate a random uuid, and add it to the uploads.json for the client to easily read.
      // then, we add all of the data necessary to uploads/UUID/data.json and uploads/UUID/audio.ogg
      let fileUUID = randomUUIDv7();
      let originalUploads = JSON.parse(fs.readFileSync("public/uploads.json"));
      originalUploads.push(fileUUID);
      fs.writeFileSync("public/uploads.json", JSON.stringify(originalUploads));
      fs.mkdirSync("public/uploads/" + fileUUID);
      fs.rename(`tmp/processed/${req.file.filename}.ogg`, `public/uploads/${fileUUID}/audio.ogg`, ()=>{});
      fs.writeFileSync(`public/uploads/${fileUUID}/data.json`, JSON.stringify({
        "uuid": fileUUID,
        "transcription": transcription.text,
        "summary": summary.choices[0]?.message?.content,
        "date": new Date().toISOString()
      }));
      // send success.
      res.sendStatus(200);
    } catch (err) {
      // error here should not happen unless rate limited or wrong key.
      // send server error.
      res.send(err);
      res.sendStatus(500);
      console.log(err);
      return;
    }
  } else {
    // file was never audio in the first place.
    // send user error.
    res.sendStatus(400);
    fs.rmSync(req.file.path);
  }
});
// simple 404 page.
app.use((req, res, next) => {
    res.status(404).send("Not found")
})

// initialize our express app.
app.listen(port, () => {
    console.log(`express app started`)
    console.log(`- http://localhost:${port}`)
})