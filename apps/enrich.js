// enrich.js
const fs = require('fs');

const API_URL = 'https://pre-prod.api.pinntag.com/v1/google';
const AUTH_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjY5N2U2ZTlhMWNhZmNlZjVkYWNhYTczZSIsInVzZXJUeXBlIjoiQnVzaW5lc3NVc2VyIiwicm9sZSI6IjY5N2U2ZTlhMWNhZmNlZjVkYWNhYTczYyIsImJ1c2luZXNzUHJvZmlsZSI6IjY5N2U1OWU0MWNhZmNlZjVkYWNhODhkZSIsImlhdCI6MTc3NjQzMTc1MSwiZXhwIjoxODA3OTY3NzUxfQ.FCQLMIHyh2SjQ19_oPKQAn5FCmQ94G1Ne02R1N75w3Y'; // your full token

async function fetchPlaceId(record) {
  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${AUTH_TOKEN}`
    },
    body: JSON.stringify({
      address: record.address1,
      latitude: record.latitude,
      longitude: record.longitude
    })
  });

  if (!response.ok) throw new Error(`API error ${response.status}`);
  const json = await response.json();
  return json?.data?.[0]?.placePrediction?.placeId ?? null;
}

async function appendPlaceIds(records, { concurrency = 5 } = {}) {
  const results = [...records];
  for (let i = 0; i < results.length; i += concurrency) {
    const batch = results.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async (record, idx) => {
        const globalIdx = i + idx;
        try {
          const placeId = await fetchPlaceId(record);
          results[globalIdx] = { ...record, placeId };
          console.log(`✓ ${record.name} → ${placeId}`);
        } catch (err) {
          console.error(`✗ ${record.name}: ${err.message}`);
          results[globalIdx] = { ...record, placeId: null };
        }
      })
    );
  }
  return results;
}

(async () => {
  const data = JSON.parse(fs.readFileSync('input.json', 'utf-8'));
  const enriched = await appendPlaceIds(data);
  fs.writeFileSync('output.json', JSON.stringify(enriched, null, 2));
  console.log(`\nDone. Wrote ${enriched.length} records to output.json`);
})();