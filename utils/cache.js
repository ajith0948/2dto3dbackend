const NodeCache = require('node-cache');
const historyCache = new NodeCache({ stdTTL: 30, checkperiod: 10 });
module.exports = { historyCache };
