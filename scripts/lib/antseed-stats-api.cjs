const { readStats } = require('./antseed-stats.cjs');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(405).json({ error: 'Use GET.' });
  }
  try {
    const data = await readStats();
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=60');
    return res.status(200).json(data);
  } catch (error) {
    console.error('AntSeedStats refresh failed:', error.message);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(502).json({ error: 'Live stats are unavailable.' });
  }
};
