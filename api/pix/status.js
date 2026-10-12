import { createHandler } from '../../server.js';
const handler = createHandler();
export default function status(req, res) {
  req.url = '/api/pix/status';
  return handler(req, res);
}
