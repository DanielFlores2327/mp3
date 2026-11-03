const express = require('express');
const User = require('../models/user');
const Task = require('../models/task');
const {
  isId, send, HttpError, wrap, sendDeleted, parseJSONParam, listQuery,
} = require('./helpers');

const router = express.Router();

// ---------- helper functions ----------

function cleanTaskBody(body) {
  body = body || {};
  const { name, deadline } = body;
  if (typeof name !== 'string' || !name.trim()) {
    throw new HttpError(400, 'A task must have a name.');
  }
  if (deadline === undefined || deadline === null || deadline === '') {
    throw new HttpError(400, 'A task must have a deadline.');
  }
  let date;
  if (typeof deadline === 'number') date = new Date(deadline);
  else if (typeof deadline === 'string') {
    date = /^\d+$/.test(deadline) ? new Date(Number(deadline)) : new Date(deadline);
  } else date = new Date(NaN);
  if (isNaN(date.getTime())) {
    throw new HttpError(400, 'The deadline is not a valid date.');
  }

  let description = body.description;
  if (description === undefined || description === null) description = '';
  if (typeof description !== 'string') {
    throw new HttpError(400, 'The description must be text.');
  }

  let completed = body.completed;
  if (completed === undefined || completed === null) completed = false;
  if (completed === 'true') completed = true;
  if (completed === 'false') completed = false;
  if (typeof completed !== 'boolean') {
    throw new HttpError(400, 'completed must be true or false.');
  }

  let assignedUser = body.assignedUser;
  if (assignedUser === undefined || assignedUser === null) assignedUser = '';
  if (typeof assignedUser !== 'string' || (assignedUser !== '' && !isId(assignedUser))) {
    throw new HttpError(400, 'assignedUser must be a valid user id or empty.');
  }

  const assignedUserName = body.assignedUserName;
  if (assignedUserName !== undefined && typeof assignedUserName !== 'string') {
    throw new HttpError(400, 'assignedUserName must be text.');
  }

  return { name, description, deadline: date, completed, assignedUser, assignedUserName };
}

// Returns the User document the task is assigned to, or null if unassigned.
async function resolveAssignee(data) {
  if (data.assignedUser) {
    const user = await User.findById(data.assignedUser);
    if (!user) throw new HttpError(404, 'The assigned user does not exist.');
    if (data.assignedUserName !== undefined && data.assignedUserName !== user.name) {
      throw new HttpError(400, 'assignedUserName does not match the assigned user.');
    }
    return user;
  }
  if (
    data.assignedUserName !== undefined &&
    data.assignedUserName !== '' &&
    data.assignedUserName !== 'unassigned'
  ) {
    throw new HttpError(400, 'assignedUserName was given without a matching assignedUser.');
  }
  return null;
}

// Keeps users' pendingTasks in sync after a task is saved.
async function syncTaskRefs(task, oldAssignedId, user) {
  const tid = String(task._id);
  if (oldAssignedId && (!user || String(user._id) !== oldAssignedId)) {
    await User.updateOne({ _id: oldAssignedId }, { $pull: { pendingTasks: tid } });
  }
  if (user) {
    await User.updateOne(
      { _id: user._id },
      task.completed
        ? { $pull: { pendingTasks: tid } }
        : { $addToSet: { pendingTasks: tid } }
    );
  }
}

function applyData(task, data, user) {
  task.name = data.name;
  task.description = data.description;
  task.deadline = data.deadline;
  task.completed = data.completed;
  task.assignedUser = user ? String(user._id) : '';
  task.assignedUserName = user ? user.name : 'unassigned';
}

// ---------- routes ----------

router.get('/', wrap(async (req, res) => {
  const data = await listQuery(Task, req, 100);
  send(res, 200, 'OK', data);
}));

router.post('/', wrap(async (req, res) => {
  const data = cleanTaskBody(req.body);
  const user = await resolveAssignee(data);
  const task = new Task();
  applyData(task, data, user);
  await task.save();
  await syncTaskRefs(task, '', user);
  send(res, 201, 'Task created.', task.toObject());
}));

router.get('/:id', wrap(async (req, res) => {
  if (!isId(req.params.id)) throw new HttpError(404, 'Task not found.');
  const select = parseJSONParam(req, 'select');
  let q = Task.findById(req.params.id);
  if (select) q = q.select(select);
  let task;
  try {
    task = await q.lean();
  } catch (err) {
    if (err.name === 'MongoServerError' || err.name === 'CastError') {
      throw new HttpError(400, 'The select parameter is invalid.');
    }
    throw err;
  }
  if (!task) throw new HttpError(404, 'Task not found.');
  send(res, 200, 'OK', task);
}));

router.put('/:id', wrap(async (req, res) => {
  if (!isId(req.params.id)) throw new HttpError(404, 'Task not found.');
  const task = await Task.findById(req.params.id);
  if (!task) throw new HttpError(404, 'Task not found.');

  const data = cleanTaskBody(req.body);
  const user = await resolveAssignee(data);
  const oldAssigned = task.assignedUser;
  applyData(task, data, user);
  await task.save();
  await syncTaskRefs(task, oldAssigned, user);
  send(res, 200, 'Task updated.', task.toObject());
}));

router.delete('/:id', wrap(async (req, res) => {
  if (!isId(req.params.id)) throw new HttpError(404, 'Task not found.');
  const task = await Task.findById(req.params.id);
  if (!task) throw new HttpError(404, 'Task not found.');
  if (task.assignedUser && isId(task.assignedUser)) {
    await User.updateOne(
      { _id: task.assignedUser },
      { $pull: { pendingTasks: String(task._id) } }
    );
  }
  await Task.deleteOne({ _id: task._id });
  sendDeleted(res, 'Task');
}));

module.exports = router;
