const express = require('express');
const User = require('../models/user');
const Task = require('../models/task');
const {
  isId, send, HttpError, wrap, sendDeleted, parseJSONParam, listQuery,
} = require('./helpers');

const router = express.Router();

function cleanUserBody(body) {
    body = body || {};
    const { name, email } = body;
    if (typeof name !== 'string' || !name.trim()) {
      throw new HttpError(400, 'A user must have a name.');
    }
    if (typeof email !== 'string' || !email.trim()) {
      throw new HttpError(400, 'A user must have an email.');
    }
    let pending = body.pendingTasks;
    if (pending === undefined || pending === null || pending === '') pending = [];
    if (typeof pending === 'string') pending = [pending];
    if (!Array.isArray(pending) || pending.some((id) => !isId(id))) {
      throw new HttpError(400, 'pendingTasks must be a list of valid task ids.');
    }
    return { name, email, pendingTasks: [...new Set(pending)] };
  }
  
  async function checkEmailFree(email, excludeId) {
    const filter = { email };
    if (excludeId) filter._id = { $ne: excludeId };
    if (await User.findOne(filter).lean()) {
      throw new HttpError(400, 'A user with this email already exists.');
    }
  }
  
  async function checkPendingTasks(ids) {
    if (!ids.length) return;
    const tasks = await Task.find({ _id: { $in: ids } }).lean();
    if (tasks.some((t) => t.completed)) {
      throw new HttpError(400, 'A completed task cannot be in pendingTasks.');
    }
    if (tasks.length !== ids.length) {
      throw new HttpError(404, 'One or more tasks in pendingTasks do not exist.');
    }
  }
  
  async function syncUserRefs(user, oldPending, newPending) {
    const id = String(user._id);
    const removed = oldPending.filter((t) => !newPending.includes(t));
    if (removed.length) {
      await Task.updateMany(
        { _id: { $in: removed }, assignedUser: id },
        { assignedUser: '', assignedUserName: 'unassigned' }
      );
    }
    if (newPending.length) {
      await User.updateMany(
        { _id: { $ne: user._id } },
        { $pull: { pendingTasks: { $in: newPending } } }
      );
      await Task.updateMany(
        { _id: { $in: newPending } },
        { assignedUser: id, assignedUserName: user.name }
      );
    }
    await Task.updateMany({ assignedUser: id }, { assignedUserName: user.name });
  }

router.get('/', wrap(async (req, res) => {
    const data = await listQuery(User, req, 0);
    send(res, 200, 'OK', data);
  }));

router.post('/', wrap(async (req, res) => {
    const data = cleanUserBody(req.body);
    await checkEmailFree(data.email);
    await checkPendingTasks(data.pendingTasks);
    const user = new User(data);
    await user.save();
    await syncUserRefs(user, [], data.pendingTasks);
    send(res, 201, 'User created.', user.toObject());
}));

router.get('/:id', wrap(async (req, res) => {
    if (!isId(req.params.id)) throw new HttpError(404, 'User not found.');
    const select = parseJSONParam(req, 'select');
    let q = User.findById(req.params.id);
    if (select) q = q.select(select);
    let user;
    try {
      user = await q.lean();
    } catch (err) {
      if (err.name === 'MongoServerError' || err.name === 'CastError') {
        throw new HttpError(400, 'The select parameter is invalid.');
      }
      throw err;
    }
    if (!user) throw new HttpError(404, 'User not found.');
    send(res, 200, 'OK', user);
  }));
  
  router.put('/:id', wrap(async (req, res) => {
    if (!isId(req.params.id)) throw new HttpError(404, 'User not found.');
    const user = await User.findById(req.params.id);
    if (!user) throw new HttpError(404, 'User not found.');
  
    const data = cleanUserBody(req.body);
    await checkEmailFree(data.email, user._id);
    await checkPendingTasks(data.pendingTasks);
  
    const oldPending = [...user.pendingTasks];
    user.name = data.name;
    user.email = data.email;
    user.pendingTasks = data.pendingTasks;
    await user.save();
    await syncUserRefs(user, oldPending, data.pendingTasks);
    send(res, 200, 'User updated.', user.toObject());
  }));
  
  router.delete('/:id', wrap(async (req, res) => {
    if (!isId(req.params.id)) throw new HttpError(404, 'User not found.');
    const user = await User.findById(req.params.id);
    if (!user) throw new HttpError(404, 'User not found.');
    await Task.updateMany(
      { assignedUser: String(user._id) },
      { assignedUser: '', assignedUserName: 'unassigned' }
    );
    await User.deleteOne({ _id: user._id });
    sendDeleted(res, 'User');
  }));
module.exports = router;
