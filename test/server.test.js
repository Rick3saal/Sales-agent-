import { test } from 'node:test';
import assert from 'node:assert/strict';
import app, { validateFlightQuery } from '../server.js';
const valid = { origin:'JFK', destination:'LHR', departureDate:'2027-04-01', travelClass:'BUSINESS', adults:'1' };
test('validates flight searches', () => {
  assert.equal(validateFlightQuery(valid), '');
  assert.match(validateFlightQuery({...valid,origin:'New York'}), /three-letter/);
  assert.match(validateFlightQuery({...valid,departureDate:'2027-02-30'}), /departure/);
  assert.match(validateFlightQuery({...valid,returnDate:'2027-03-01'}), /return/);
  assert.match(validateFlightQuery({...valid,adults:'10'}), /adults/);
  assert.match(validateFlightQuery({...valid,travelClass:'PRIVATE'}), /cabin/);
});
test('status and unconfigured services give actionable responses', async () => {
  const old = [process.env.OPENAI_API_KEY, process.env.AMADEUS_CLIENT_ID, process.env.AMADEUS_CLIENT_SECRET];
  delete process.env.OPENAI_API_KEY; delete process.env.AMADEUS_CLIENT_ID; delete process.env.AMADEUS_CLIENT_SECRET;
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    assert.deepEqual(await (await fetch(`${url}/api/status`)).json(), {ai:false, flights:false, flightEnvironment:'test'});
    const coach = await fetch(`${url}/api/coach`, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({transcript:'hello'})});
    assert.equal(coach.status,503); assert.match((await coach.json()).error,/OPENAI_API_KEY/);
    const flights = await fetch(`${url}/api/flights`); assert.equal(flights.status,503);
    assert.equal((await fetch(url)).status,200);
  } finally { server.close(); ['OPENAI_API_KEY','AMADEUS_CLIENT_ID','AMADEUS_CLIENT_SECRET'].forEach((key, i) => { if (old[i] === undefined) delete process.env[key]; else process.env[key] = old[i]; }); }
});
