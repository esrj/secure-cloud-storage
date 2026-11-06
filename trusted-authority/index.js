/**
 * This file handles communication with client, mainly for search key retrieval.
 */
// import dotenv from "dotenv";
// dotenv.config({ path: "data/.env" });
import './src/EnvInjection.js'

import express from "express";
import cors from 'cors'
import { Server } from "socket.io";
import {
  logger,
  logSocketInfo,
  logInvalidSchemaWarning,
  logSocketWarning,
  logSocketError,
} from "./src/Logger.js";
import { createServer } from "https";
import { readFileSync } from "fs";

import { TrustedAuthority } from "./src/TrustedAuthority.js";
import { AuthRequestSchema, AuthResRequestSchema } from "./src/Validation.js";
import {
  InternalServerErrorMsg,
  InvalidArgumentErrorMsg,
  NotRegisteredInErrorMsg,
} from "./src/Utils.js";
import CryptoHandler from "./src/CryptoHandler.js";
import { getArrayParamsCount, getUserAttrIds } from "./src/Database.js";
import { getUserId } from "./src/Communication.js";

const SERVER_PORT = process.env.SERVER_PORT || 2999;
const KEY_PATH = process.env.KEY_PATH || "data/tls.key";
const CERT_PATH = process.env.CERT_PATH || "data/tls.crt";

// Create an express server
const app = express();
app.set(`trust proxy`, true);
app.use(cors())

const options = {
  key: readFileSync(KEY_PATH),
  cert: readFileSync(CERT_PATH),
  maxHttpBufferSize: 1e8, // 100 MB, may need to increase
};

const server = createServer(options, app);

const TA = new TrustedAuthority();
await TA.init();

const io = new Server(server, {
  cors: {
    origin: "*",
  },
});

io.on("connection", (socket) => {
  socket.ip = socket.handshake.address;
  // May need to get address from header if server is behind a proxy
  // See https://socket.io/how-to/get-the-ip-address-of-the-client
  socket.use(([event], next) => {
    socket.event = event;
    next();
  });
  logSocketInfo(socket, "Client connected.");

  socket.on("disconnect", () => {
    logSocketInfo(socket, "Client disconnected.", { event: undefined });
  });

  /**
   * Client ask to authenticate, will ask to decode a verifying message.
   */
  socket.on("auth", async (request, cb) => {
    try {
      const actionStr = "Client asks to authenticate";
      logSocketInfo(socket, actionStr + ".", request);

      const result = AuthRequestSchema.safeParse(request);
      if (!result.success) {
        logInvalidSchemaWarning(
          socket,
          actionStr,
          result.error.issues,
          request
        );
        cb({ errorMsg: InvalidArgumentErrorMsg });
        return;
      }
      const { publicKey } = result.data;

      // Check if user is registered on server.
      const userId = await getUserId(publicKey);
      if (!userId) {
        logSocketWarning(socket, actionStr + " but is not registered.");
        cb({ errorMsg: NotRegisteredInErrorMsg });
        return;
      }
      socket.userId = userId

      // Generate random message for authentication
      const { message, cipher, spk } = await CryptoHandler.verifyGen(publicKey);
      socket.randKey = message;
      socket.pk = publicKey;
      logSocketInfo(
        socket,
        "Asking client to respond with correct authentication key."
      );
      cb({ cipher, spk });
      // Wait for auth-res
    } catch (error) {
      logSocketError(socket, error, request);
      cb({ errorMsg: InternalServerErrorMsg });
    }
  });

  /**
   * Client respond to authenticate with the verifying message.
   * Returns with the user's search key.
   */
  socket.on("auth-res", async (request, cb) => {
    try {
      const actionStr = "Client responds to authentication";
      logSocketInfo(socket, actionStr + ".", request);

      const result = AuthResRequestSchema.safeParse(request);
      if (!result.success) {
        logInvalidSchemaWarning(
          socket,
          actionStr,
          result.error.issues,
          request
        );
        cb({ errorMsg: InvalidArgumentErrorMsg });
        return;
      }
      const { decryptedValue, y } = result.data; // y is the attribute array
      if (y && y.length() != TA.arrayParamLength) {
        cb({ errorMsg: InvalidArgumentErrorMsg });
        return;
      }

      if (socket.randKey !== decryptedValue) {
        logSocketWarning(
          socket,
          actionStr + " with incorrect authentication key.",
          {
            ...request,
            randKey: socket.randKey,
          }
        );
        if (socket.userId) addFailure(socket.userId);
        cb({ errorMsg: "Incorrect authentication key." });
        return;
      }
      // Authentication passed
      logSocketInfo(
        socket,
        "Authentication key correct. Client is authenticated."
      );

      // Check if user attribute have changed. If not, return null. If changed, calculate and return new key.
      // If no previous attribute, new Key is returned.
      // Actually always calculate new key.
      let newKey = null;
      const userAttrIds = getUserAttrIds.all(socket.userId);
      const newY = new Array(TA.arrayParamLength).fill(0);
      userAttrIds.forEach((row) => {
        newY[row.attrid] = 1;
      });
      newY[newY.length - 1] = 1
      for (let i = 0; i < newY.length; i++) {
        if (y == null || y[i] != newY[i]) {
          newKey = TA.KeyGen(newY);
          break;
        }
      }
      logSocketInfo(socket, `Sending search key to client.`)
      cb({ SK: newKey, y: newY }); // new key or null
    } catch (error) {
      logSocketError(socket, error);
      cb({ errorMsg: InternalServerErrorMsg });
    }
  });
});

/**
 * Path for getting public parameters
 */
app.get("/pp", (req, res, next) => {
  try {
    logger.info("Public parameter fetched.", { ip: req.ip });
    res.status(200).json(TA.serializedPP);
  } catch (error) {
    next(error);
  }
});

// Error handler
app.use((err, req, res, next) => {
  logger.error(err, { ip: req.ip });
  res.status(500); // also modify server
});

server.listen(SERVER_PORT, () => {
  logger.info(`Server is running on port ${SERVER_PORT}`);
});
