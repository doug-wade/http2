'use strict';

const http2 = process.binding('http2');
const EventEmitter = require('events');
const TLSServer = require('tls').Server;
const NETServer = require('net').Server;
const stream = require('stream');
const Writable = stream.Writable;
const Readable = stream.Readable;
const PassThrough = stream.PassThrough;
const constants = http2.constants;

const kHandle = Symbol('handle');
const kType = Symbol('type');
const kStream = Symbol('stream');
const kStreams = Symbol('streams');
const kHeaders = Symbol('headers');
const kHeadersSent = Symbol('headers-sent');
const kSession = Symbol('session');
const kOutgoingData = Symbol('outgoing-data');
const kRequest = Symbol('request');
const kResponse = Symbol('response');
const kFinished = Symbol('finished');
const kSocket = Symbol('socket');
const kTrailers = Symbol('trailers');
const kChunks = Symbol('chunks');
const kProvider = Symbol('provider');
const kPaused = Symbol('paused');
const kResume = Symbol('resume');
const kBeginResponse = Symbol('begin-response');
const kEndStream = Symbol('end-stream');
const kHasTrailers = Symbol('has-trailers');

Object.defineProperty(exports, 'constants', {
  configurable: false,
  enumerable: true,
  value: constants
});

class Http2Session extends EventEmitter {
  constructor(type) {
    super();
    type |= 0;
    if (type !== constants.SESSION_TYPE_SERVER &&
        type !== constants.SESSION_TYPE_CLIENT) {
      throw new TypeError('Invalid session type');
    }
    this[kStreams] = new Map();
    const session = new http2.Http2Session(type);

    session[constants.CALLBACK_ONSEND] = (buffer) => {
      process.nextTick(() => this.emit('send', buffer));
    };

    // Called at the beginning of a new block of headers.
    session[constants.CALLBACK_ONBEGINHEADERS] = (stream, category) => {
      // stream is the Http2Stream object the headers belong to
      // category is the header type category from constants
      if ((type === constants.SESSION_TYPE_SERVER &&
           category === constants.NGHTTP2_HCAT_RESPONSE ||
           category === constants.NGHTTP2_HCAT_PUSH_RESPONSE) ||
          (type === constants.SESSION_TYPE_CLIENT &&
           category === constants.NGHTTP2_HCAT_REQUEST)) {
        this.rstStream(stream, constants.NGHTTP2_PROTOCOL_ERROR);
        return;
      }
      if (category === constants.NGHTTP2_HCAT_REQUEST ||
          category === constants.NGHTTP2_HCAT_RESPONSE) {
        this[kStreams].set(stream.id, stream);
      }
      process.nextTick(() => this.emit('begin-headers', stream, category));
    };

    session[constants.CALLBACK_ONHEADER] = (stream, name, value) => {
      // stream is the Http2Stream object the header belongs to
      // name is the header name
      // value is the header value
      process.nextTick(() => this.emit('header', stream, name, value));
    };

    session[constants.CALLBACK_ONHEADERS] = (stream, flags) => {
      // stream is the Http2Stream object the headers belong to
      // flags is the header flags from constant
      // if this is a server, emit a request
      // if this ia a client, emit a response
      const finished = Boolean(flags & constants.NGHTTP2_FLAG_END_STREAM);
      process.nextTick(() => this.emit('headers-complete', stream, finished));
    };

    session[constants.CALLBACK_ONSTREAMCLOSE] = (stream, code) => {
      // stream is the Http2Stream object that is being closed.
      // code is the error code
      this[kStreams].delete(stream.id);
      process.nextTick(() => this.emit('stream-close', stream.id, code));
    };

    session[constants.CALLBACK_ONDATACHUNK] = (streamID, flags, data) => {
      // streamID is the numeric stream ID the data belongs to
      // flags is the data flags
      // data is the Buffer containing the data
      const stream = this[kStreams].get(id);
      process.nextTick(() => this.emit('data-chunk', stream, chunk));
    };

    session[constants.CALLBACK_ONDATA] = (stream, flags, length, padding) => {
      // stream is the Http2Stream object the data belongs to
      // flags is the frame flags
      // length is the amount of data
      // padding is the amount of padding in the data
      const finished = Boolean(flags & constants.NGHTTP2_DATA_FLAG_EOF ||
                               flags & constants.NGHTTP2_FLAG_END_STREAM);
      process.nextTick(() => this.emit('data-end', stream, finished, padding));
    };

    session[constants.CALLBACK_ONFRAMESEND] = (streamID, type, flags) => {
      // streamID is the stream the frame belongs to
      // type is the frame type
      // flags are the frame flags
      process.nextTick(() => this.emit('frame-sent', streamID, type, flags));
    };

    session[constants.CALLBACK_ONGOAWAY] = (code, lastStreamID, data) => {
      // code is the error code
      // lastStreamID is the last processed stream ID
      // data is the optional additional application data
      process.nextTick(() => this.emit('goaway', code, lastStreamID, data));
    };
    session[constants.CALLBACK_ONRSTSTREAM] = (stream, code) => {
      // stream is the stream object
      // code is the RstStream code
      this[kStreams].delete(stream.id);
      process.nextTick(() => this.emit('rst-stream', stream, code));
    };

    //session[constants.CALLBACK_ONPRIORITY] = () => {};
    //session[constants.CALLBACK_ONSETTINGS] = () => {};
    //session[constants.CALLBACK_ONPING] = () => {};
    this[kHandle] = session;
  }

  get localWindowSize() {
    return this._handle.localWindowSize;
  }

  get inflateDynamicTableSize() {
    return this._handle.inflateDynamicTableSize;
  }

  get deflateDynamicTableSize() {
    return this._handle.deflateDynamicTableSize;
  }

  get remoteWindowSize() {
    return this._handle.remoteWindowSize;
  }

  get outboundQueueSize() {
    return this._handle.outboundQueueSize;
  }

  get lastProcStreamID() {
    return this._handle.lastProcStreamID;
  }

  get effectiveRecvDataLength() {
    return this._handle.effectiveRecvDataLength;
  }

  get effectiveLocalWindowSize() {
    return this._handle.effectiveLocalWindowSize;
  }

  get nextStreamID() {
    return this._handle.nextStreamID;
  }

  set nextStreamID(id) {
    this._handle.nextStreamID = id;
  }

  get _handle() {
    return this[kHandle];
  }

  resumeData(stream) {
    const err = this._handle.resumeData(stream);
    if (err) process.nextTick(() => this.emit('error', err));
  }

  respond(stream, headers, provider) {
    const err = this._handle.respond(stream, headers, provider);
    if (err) process.nextTick(() => this.emit('error', err));
  }

  destroy() {
    const err = this._handle.destroy();
    this[kHandle] = null;
    if (err) process.nextTick(() => this.emit('error', err));
  }

  terminate(code) {
    // TODO(jasnell): lastProcStreamID?
    code |= 0;
    const err = this._handle.terminate(code);
    if (err) process.nextTick(() => this.emit('error', err));
  }

  sendConnectionHeader() {
    const err = this._handle.sendServerConnectionHeader();
    if (err) process.nextTick(() => this.emit('error', err));
    this.sendData();
  }

  /**
   * When a chunk of data is received by the Socket, the receiveData
   * method passes that data on to the underlying nghttp2_session. The
   * data argument must be a Buffer.
   **/
  receiveData(data) {
    const err = this._handle.receiveData(data);
    if (err) process.nextTick(() => this.emit('error', err));
  }

  /**
   * Prompts the nghttp2_session to serialize and send (via callbacks) any
   * http/2 frames currently in it's outgoing queue.
   **/
  sendData() {
    const err = this._handle.sendData();
    if (err) process.nextTick(() => this.emit('error', err));
  }

  changeStreamPriority(stream, parent, weight, exclusive) {
    // TODO(jasnell): Implement this
  }

  consume(stream, size) {
    stream = Number.isNaN(stream) ? stream.id : stream;
    size |= 0;
    const err = this._handle.consume(stream, size);
    if (err) process.nextTick(() => this.emit('error', err));
  }

  consumeSession(size) {
    size |= 0;
    const err = this._handle.consume(stream, size);
    if (err) process.nextTick(() => this.emit('error', err));
  }

  consumeStream(stream, size) {
    stream = Number.isNaN(stream) ? stream.id : stream;
    size |= 0;
    const err = this._handle.consume(stream, size);
    if (err) process.nextTick(() => this.emit('error', err));
  }

  rstStream(stream, code) {
    stream = isNaN(stream) ? stream.id : stream;
    code |= 0;
    const err = this._handle.rstStream(stream, code);
    if (err) process.nextTick(() => this.emit('error', err));
  }

  createIdleStream(stream, parent, weight, exclusive) {
    // TODO(jasnell): Implement this
  }
}

class Headers extends Map {
  constructor(type) {
    super();
    this[kType] = type;
  }
}

// TODO(jasnell): This should not be a PassThrough. It needs to be
// just a Readable so that the Writable methods are not accessible
// to users. For now, this is the easiest thing to just get it working.
class Http2Request extends PassThrough {
  constructor(session, stream, headers, socket) {
    super({});
    this[kSession] = session;
    this[kStream] = stream;
    this[kSocket] = socket;
    this[kHeaders] = headers;
  }

  get headers() {
    return this[kHeaders];
  }

  get method() {
    return this.headers.get(':method');
  }

  get authority() {
    return this.headers.get(':authority');
  }

  get scheme() {
    return this.headers.get(':scheme');
  }

  get url() {
    return this.headers.get(':path');
  }

  get httpVersion() {
    return '2.0';
  }

  get socket() {
    return this[kSocket];
  }

  get trailers() {
    return this[kTrailers];
  }

  setTimeout(msec, callback) {
    if (callback)
      this.on('timeout', callback);
    this.socket.setTimeout(msecs);
    return this;
  }
}

class Http2Response extends Writable {
  constructor(session, stream, socket) {
    super({});
    this[kSession] = session;
    this[kStream] = stream;
    this[kFinished] = false;
    this[kSocket] = socket;
    this[kHeaders] = new Map();
    this[kTrailers] = new Map();
    this[kHeadersSent] = false;
    this[kChunks] = [];

    // The Http2DataProvider objects wraps a nghttp2_data_provider internally
    // that supplies outbound data to the stream. The Http2Response object is
    // a Writable stream that stores the chunks of written data into a simple
    // this[kchunks] array (currently). The Http2DataProvider object simply
    // harvests the chunks from that array. TODO: Make this more efficient,
    // perhaps by using a PassThrough stream.
    this[kProvider] = new http2.Http2DataProvider(stream);
    // This callback is invoked from node_http2.cc while the outgoing data
    // frame is being processed. The buffer argument is a pre-allocated, fixed
    // sized buffer to read the data into. flags is an object that supports
    // two properties used to indicate if the data has concluded or not.
    // The callback must return the actual number of bytes written up to but
    // not exceeding buffer.length
    this[kProvider][constants.CALLBACK_ONDATA] = (buffer, flags) => {
      const chunks = this[kChunks];
      if (chunks.length === 0) {
        if (!this[kFinished]) {
          // The end() method has not yet been called but there's
          // currently no data in the queue, defer the data frame
          // until additional data is written.
          this[kPaused] = true;
          return constants.NGHTTP2_ERR_DEFERRED;
        } else {
          // There is no more data in the queue and end() has
          // been called. Set the flags. Note: this will cause
          // an extra empty data frame to be sent. See below.
          this[kEndStream](flags);
          return 0;
        }
      } else {
        if (this[kFinished]) {
          // Finish has been called so there will
          // not be any more data queued. Set the
          // flags to avoid another data frame write.
          // Assuming that finish has been called before
          // all of the data could be harvested, this ensures
          // that we do not have to send an extra empty data
          // frame to signal the end of the data. However,
          // it's not always possible to know this in advance.
          this[kEndStream](flags);
        }
        // Consume as much of the currently buffered 
        // data as possible per data frame up to buffer.length
        return copyBuffers(buffer, chunks);
      }
    };

    // If this Writable is connected to a pipe, resume any deferred data
    // frames and initiate the response if it hasn't been initiated already.
    this.on('pipe', () => {
      this[kResume]();
      this[kBeginResponse]();
    });
    
    this.statusCode = 200;
  }

  get socket() {
    return this[kSocket];
  }

  get finished() {
    return this[kFinished];
  }

  get headersSent() {
    return this[kHeadersSent];
  }

  get statusCode() {
    this[kHeaders].get(':status');
  }

  set statusCode(code) {
    code |= 0;
    if (code < 100 || code > 999)
      throw new RangeError(`Invalid status code: ${code}`);
    this[kHeaders].set(':status', code);
  }

  setHeader(name, value) {
    name = String(name).toLowerCase().trim();
    // Delete the current value if it's null
    if (value === undefined || value === null) {
      this[kHeaders].delete(name);
      return this;
    }
    // Cannot add headers that start with the :-prefix
    if (name[0] === ':')
      throw new TypeError('Cannot add HTTP/2 pseudo-headers');
    if (Array.isArray(value)) {
      this[kHeaders].set(name, value.map((i) => String(i)));
    } else {
      this[kHeaders].set(name, String(value));
    }
    return this;
  }

  setTrailer(name, value) {
    name = String(name).toLowerCase().trim();
    // Delete the current value if it's null
    if (value === undefined || value === null) {
      this[kTrailers].delete(name);
      return this;
    }
    // Cannot add headers that start with the :-prefix
    if (name[0] === ':')
      throw new TypeError('Cannot add HTTP/2 pseudo-headers');
    if (Array.isArray(value)) {
      this[kTrailers].set(name, value.map((i) => String(i)));
    } else {
      this[kTrailers].set(name, String(value));
    }
    return this;
  }

  addTrailers(headers) {
    var keys = Object.keys(headers);
    for (var key of keys)
      this.setTrailer(key, headers[key]);
    return this;
  }

  getHeader(name) {
    return this[kHeaders].get(name);
  }

  getTrailer(name) {
    return this[kTrailers].get(name);
  }

  removeHeader(name) {
    this[kHeaders].delete(name);
    return this;
  }

  removeTrailer(name) {
    this[kTrailers].delete(name);
    return this;
  }

  setTimeout(msec, callback) {
    if (callback)
      this.on('timeout', callback);
    this.socket.setTimeout(msecs);
    return this;
  }

  writeContinue() {
    this[kSession].continue(this[kStream]);
  }

  writeHead(statusCode, headers) {
    this.statusCode = statusCode;
    const keys = Object.keys(headers);
    for (var key of keys)
      this.setHeader(key, headers[key]);
    return this;
  }

  _write(chunk, encoding, callback) {
    if (typeof chunk === 'string')
      chunk = Buffer.from(chunk, encoding);
    if (chunk.length > 0)
      this[kChunks].push(chunk);
    callback();
    this[kResume]();
    this[kBeginResponse]();
    this[kSession].sendData(this[kStream]);
  }

  end(data, encoding, callback) {
    if (typeof encoding === 'function') {
      callback = encoding;
      encoding = undefined;
    }
    if (data) {
      this.write(data, encoding);
      super.end(callback);
    }
    this[kFinished] = true;
    this[kResume]();
    this[kBeginResponse]();
  }

  [kBeginResponse]() {
    if (!this[kHeadersSent]) {
      this[kHeadersSent] = true;
      this[kSession].respond(this[kStream],
                             mapToHeaders(this[kHeaders]),
                             this[kProvider]);
    }
  }

  [kResume]() {
    if (this[kPaused]) {
      this[kPaused] = false;
      this[kSession].resumeData(this[kStream]);
      this[kSession].sendData(this[kStream]);
    }
  }

  [kEndStream](flags) {
    flags[Http2Session.kFlagEndData] = true;
    // TODO(jasnell): trailers
    if (this[kHasTrailers]) {
      flags[constants.FLAG_NOENDSTREAM] = true;
      this[kSession].sendTrailers(this[kStream],
                                  mapToHeaders(this[kTrailers]));
    } else {
      flags[constants.FLAG_ENDSTREAM] = true;
    }
  }
}

function mapToHeaders(map) {
  const ret = [];
  if (!(map instanceof Map))
    return ret;
  for (const v of map) {
    const key = v[0];
    const value = v[1];
    if (Array.isArray(value)) {
      for (const item of value)
        ret.push(new http2.Http2Header(key.toLowerCase(), String(item)));
    } else {
      ret.push(new http2.Http2Header(key.toLowerCase(), String(value)));
    }
  }
  return ret;
}

function copyBuffers(buffer, chunks, offset) {
  if (chunks.length === 0) return 0;
  var current = chunks[0];
  offset |= 0;
  if (current.length <= buffer.length - offset) {
    var copied = current.copy(buffer, offset, 0);
    chunks.shift();
    if (chunks.length > 0)
      copied += copyBuffers(buffer, chunks, offset + copied);
    return copied;
  } else {
    const len = buffer.length - offset;
    current.copy(buffer, offset, 0, len);
    chunks[0] = current.slice(len);
    return len;
  }
}

function connectionListener(socket) {
  const options = {};
  const session = socket[kSession] = createServerSession(options, socket);

  socket[kOutgoingData] = 0;

  function updateOutgoingData(delta) {
    // `outgoingData` is an approximate amount of bytes queued through all
    // inactive responses. If more data than the high watermark is queued - we
    // need to pause TCP socket/HTTP parser, and wait until the data will be
    // sent to the client.
    outgoingData += delta;
    if (socket._paused && outgoingData < socket._writableState.highWaterMark)
      return socketOnDrain();
  }

  // Set up the timeout listener
  if (this.timeout)
    socket.setTimeout(this.timeout);
  socket.on('timeout', () => {
    if (!this.emit('timeout', socket)) {
      socket.destroy();
    }
  });

  // Destroy the session if the socket is destroyed
  const destroySocket = socket.destroy;
  socket.destroy = function() {
    session.destroy();
    destroySocket.call(socket);
  };

  // Terminate the session if socket.end() is called
  const endSocket = socket.end;
  socket.end = function(data, encoding) {
    // needs to write the data, then terminate the session,
    // *then* end the socket
    socket.write(data, encoding, () => {
      session.terminate();
      // end the socket somehow
    });
  };

  socket.on('error', socketOnError);
  socket.on('close', socketOnClose);
  socket.on('end', socketOnEnd);
  socket.on('data', socketOnData);
  socket.on('resume', socketOnResume);
  socket.on('pause', socketOnPause);
  socket.on('drain', socketOnDrain);

  session.on('send', (data) => socket.write(data));
  session.on('begin-headers', (stream, category) => {
    stream[kHeaders] = new Headers(category);
  });
  session.on('header', (stream, name, value) => {
    const headers = stream[kHeaders];
    if (!headers.has(name)) {
      headers.set(name, value);
    } else {
      const existing = headers.get(name);
      if (Array.isArray(existing))
        existing.push(value);
      else
        headers.set(name, [existing, value]);
    }
  });
  session.on('headers-complete', (stream, finished) => {
    const headers = stream[kHeaders];
    switch (headers[kType]) {
      case constants.NGHTTP2_HCAT_REQUEST:
        stream[kRequest] = new Http2Request(session, stream, headers, socket);
        stream[kResponse] = new Http2Response(session, stream, socket);
        if (finished) {
          stream[kRequest][kFinished] = true;
          stream[kRequest].end();
        }
        process.nextTick(() => {
          this.emit('request', stream[kRequest], stream[kResponse]);
        });
        break;
      case constants.NGHTTP2_HCAT_HEADERS:
        // ignore interstitial header blocks for now, only pay attention
        // if the header block finishes the steam, these will be the
        // trailers
        if (!finished) return;
        const request = stream[kRequest];
        if (!request) {
          const err = new Error('Invalid Http2Session State');
          process.nextTick(() => this.emit('error', err));
          return;
        }
        request[kTrailers] = headers;
        break;
      default:
        session.rstStream(stream, constants.NGHTTP2_PROTOCOL_ERROR);
    }
  });
  session.on('data-chunk', (stream, chunk) => {
    const request = stream[kRequest];
    if (!request) {
      const err = new Error('Invalid Http2Session State');
      process.nextTick(() => session.emit('error', err));
      return;
    }
    request.write(chunk);
  });
  session.on('data-end', (stream, finished, padding) => {
    // TODO: How to handle padding????
    const request = stream[kRequest];
    if (!request) {
      const err = new Error('Invalid Http2Session State');
      process.nextTick(() => session.emit('error', err));
      return;
    }
    if (finished) {
      request[kFinished] = finished;
      request.end();
    }
  });
  session.on('stream-close', (stream, code) => {});
  session.on('rst-stream', (stream, code) => {});
  session.on('goaway', (code) => {});

  // Now that the socket is setup, send the HTTP/2 server handshake
  session.sendConnectionHeader();
}

function socketOnError(error) {
  const session = this[kSession];
}

function socketOnClose() {
  const session = this[kSession];
}

function socketOnEnd() {
  const session = this[kSession];
}

function socketOnData(data) {
  const session = this[kSession];
  const err = session.receiveData(data);
  if (err) {
    throw err;
  }
  session.sendData();
}

function socketOnResume() {
  if (this._paused) {
    this.pause();
    return;
  }

  if (this._handle && !this._handle.reading) {
    this._handle.reading = true;
    this._handle.readStart();
  }
}

function socketOnPause() {
  if (this._handle && this._handle.reading) {
    this._handle.reading = false;
    this._handle.readStop();
  }
}

function socketOnDrain() {
  const needPause = this[kOutgoingData] > this._writableState.highWaterMark;
  if (this._paused && !needPause) {
    this._paused = false;
    this.resume();
  }
}

function initializeTLSOptions(options) {
  options = options || {};
  options.ALPNProtocols = ['hc', 'h2'];
  options.NPNProtocols = ['hc', 'h2'];
  return options;
}

class Http2SecureServerSession extends TLSServer {
  constructor(options, requestListener) {
    super(initializeTLSOptions(options), connectionListener);
    if (typeof requestListener === 'function')
      this.on('request', requestListener);
    this.on('tlsClientError', (err, conn) => {
      if (!this.emit('clientError', err, conn))
        conn.destroy(err);
    });
  }
}

class Http2ServerSession extends NETServer {
  constructor(options, requestListener) {
    super(connectionListener);
    if (typeof requestListener === 'function')
      this.on('request', requestListener);
  }
}

function createServerSession(options) {
  return new Http2Session(constants.SESSION_TYPE_SERVER);
};
 
function createClientSession(options) {
  return new Http2Session(constants.SESSION_TYPE_CLIENT);
};

function createSecureServer(options, handler) {
  return new Http2SecureServerSession(options, handler);
}

function createServer(options, handler) {
  return new Http2ServerSession(options, handler);
}

module.exports.createServer = createServer;
module.exports.createSecureServer = createSecureServer;
module.exports.createServerSession = createServerSession;
module.exports.createClientSession = createClientSession;
