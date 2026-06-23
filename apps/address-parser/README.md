# pinntag-address-parser

Standalone HTTP wrapper around [libpostal](https://github.com/openvenues/libpostal). Runs on its
own port so the libpostal C library + its ~2GB trained-data files stay **off** the API box.

## Endpoints

- `GET /health` → `{ status: "ok" | "degraded", libpostal_loaded, import_error }`.
- `POST /parse` body `{ address: string }` → `{ road, house, city, state, postcode, country, raw[] }`.

`raw[]` carries the unmapped libpostal labels in original order (e.g. `suburb`, `state_district`)
so the API or an operator can review what libpostal actually classified.

## Run locally

```bash
cd apps/address-parser
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 4101
```

Health check: `curl http://localhost:4101/health`.

If libpostal isn't installed yet, `/health` returns `"status":"degraded"` and `/parse` 503s.
The service still boots — install libpostal first, then restart.

## EC2 deploy (libpostal + data, then pm2)

```bash
# 1. Build deps + libpostal C library (one-time, ~10 min, ~2GB data).
sudo apt-get install -y curl autoconf automake libtool pkg-config python3-dev
sudo mkdir -p /opt/libpostal-data
cd /tmp
git clone https://github.com/openvenues/libpostal
cd libpostal
./bootstrap.sh
./configure --datadir=/opt/libpostal-data
make -j$(nproc) && sudo make install
sudo ldconfig

# 2. Python virtualenv + pypostal binding (postal==1.1.10).
cd /home/ubuntu/pinntag-dop/apps/address-parser
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt

# 3. Run under pm2 as a second process, separate port + cwd.
pm2 start "venv/bin/uvicorn main:app --host 0.0.0.0 --port 4101" \
  --name pinntag-dop-address-parser \
  --cwd /home/ubuntu/pinntag-dop/apps/address-parser \
  --interpreter none
pm2 save
```

## API integration

The DOP API does NOT depend on libpostal. It reads `ADDRESS_PARSER_URL` (default
`http://localhost:4101`) and POSTs the captured `googleFormattedAddress` to `/parse`. If the
microservice is down or 503s, the API logs and leaves `addressStatus='address_unparsed'` so the
batch can be re-run later — never blocks.
