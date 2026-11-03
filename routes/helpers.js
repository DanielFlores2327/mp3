const DELETE_STATUS = 204;

const ID_RE = /^[a-f\d]{24}$/i;
const isId = (v) => typeof v === 'string' && ID_RE.test(v);

const send = (res, status, message, data = {}) =>
  res.status(status).json({ message, data });

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function handleError(res, err) {
  if (err instanceof HttpError) return send(res, err.status, err.message);
  console.error(err);
  return send(res, 500, 'Something went wrong on the server. Please try again later.');
}

const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch((err) => handleError(res, err));

function sendDeleted(res, what) {
  if (DELETE_STATUS === 204) return res.status(204).end();
  return send(res, DELETE_STATUS, `${what} deleted successfully.`, {});
}

function parseJSONParam(req, name) {
  const raw = req.query[name];
  if (raw === undefined) return undefined;
  const bad = new HttpError(400, `The '${name}' parameter must be a valid JSON object.`);
  if (typeof raw !== 'string') throw bad;
  let v;
  try {
    v = JSON.parse(raw);
  } catch (e) {
    throw bad;
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw bad;
  return v;
}

function parseIntParam(req, name) {
  const raw = req.query[name];
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim())) {
    throw new HttpError(400, `The '${name}' parameter must be a non-negative integer.`);
  }
  return parseInt(raw, 10);
}

function isBadQueryError(err) {
  return (
    err &&
    (err.name === 'CastError' ||
      err.name === 'StrictModeError' ||
      err.name === 'MongoServerError')
  );
}

// Handles where / sort / select / skip / limit / count using Mongoose methods.
async function listQuery(Model, req, defaultLimit) {
  const where = parseJSONParam(req, 'where') || {};
  const sort = parseJSONParam(req, 'sort');
  const select = parseJSONParam(req, 'select');
  const skip = parseIntParam(req, 'skip');
  const limit = parseIntParam(req, 'limit');
  const count = String(req.query.count).toLowerCase() === 'true';

  try {
    if (count) return await Model.countDocuments(where);
    let q = Model.find(where);
    if (sort) q = q.sort(sort);
    if (select) q = q.select(select);
    if (skip !== undefined) q = q.skip(skip);
    const lim = limit !== undefined ? limit : defaultLimit;
    if (lim) q = q.limit(lim);
    return await q.lean();
  } catch (err) {
    if (isBadQueryError(err)) {
      throw new HttpError(400, 'One of the query parameters is invalid.');
    }
    throw err;
  }
}

module.exports = {
  isId, send, HttpError, handleError, wrap, sendDeleted,
  parseJSONParam, listQuery,
};