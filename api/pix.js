import { createHandler } from '../server.js';
const handler = createHandler();
export default function pix(req, res) {
  req.url = '/api/pix';
  return handler(req, res);
}
