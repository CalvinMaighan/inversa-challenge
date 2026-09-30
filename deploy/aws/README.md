# AWS: GOES-19 push (H4)

The only AWS pieces in this project are one SQS queue that receives NOAA NODD's
`NewGOES19Object` notifications and one IAM user that may read it. Everything else
(object download, decode, storage) runs in the Axum API on Hetzner and hits the public
`noaa-goes19` bucket anonymously.

Region: **us-east-1** (the NODD topic lives there; an SQS queue can only subscribe to an
SNS topic in its own region).

Files in this directory:

| File | Used for |
|---|---|
| `goes-filter-policy.json` | SNS subscription filter, `FilterPolicyScope=MessageBody`, admits only the four products |
| `sqs-queue-policy.json` | Queue access policy letting that one SNS topic send |
| `iam-consumer-policy.json` | IAM user policy: `sqs:ReceiveMessage`, `sqs:DeleteMessage`, `sqs:GetQueueAttributes` on the queue |

Replace `YOUR_ACCOUNT_ID` in the two policies with the 12-digit account id before use.

## What the consumer expects

`api/src/ingest/push/goes_sqs.rs`:

- Long-polls `ReceiveMessage` (JSON protocol, SigV4, `WaitTimeSeconds=20`, `MaxNumberOfMessages=10`).
- Parses the SNS envelope (raw message delivery **off**) and the S3 event inside it.
- Downloads `https://noaa-goes19.s3.amazonaws.com/<key>` for `ABI-L2-LSTC`, `ABI-L2-SSTF`,
  `ABI-L2-FDCC` and the top-of-hour `ABI-L2-ACMC` scan, deletes messages that carry nothing wanted,
  and deletes a message only after its rows are committed. Decoded rows go to the 0.05 deg GOES
  grid described below.
- Reads `GOES_SQS_URL`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` from the environment
  (PLAN.md C13). With any of the three missing the source is disabled and the API boots normally.

Queue settings that matter: visibility timeout 300 s (download of a 26 MB SSTF file plus decode
plus commit must fit; a message that is not deleted in time is redelivered, which is harmless
because rows are upserted), message retention 1 hour (a stale scan is worthless), receive wait 20 s.

## Console steps

1. **SQS, create queue.** Standard queue, name `goes19-nodd`, region N. Virginia (us-east-1).
   Visibility timeout 5 minutes, message retention 1 hour, delivery delay 0, receive message wait
   time 20 seconds, encryption disabled (the payload is a public object key).
2. **Queue access policy.** On the same create page pick "Advanced" under Access policy and paste
   `sqs-queue-policy.json` with your account id filled in. It allows `sqs:SendMessage` from
   `sns.amazonaws.com` only when `aws:SourceArn` is `arn:aws:sns:us-east-1:123901341784:NewGOES19Object`.
3. **Subscribe.** SNS console, Subscriptions, Create subscription. Topic ARN
   `arn:aws:sns:us-east-1:123901341784:NewGOES19Object` (type it; the topic is in NOAA's account),
   protocol Amazon SQS, endpoint the queue ARN from step 1. Leave "Enable raw message delivery"
   **unchecked**. Open "Subscription filter policy", set the scope to **Message body** and paste
   `goes-filter-policy.json`. Create. The status becomes Confirmed on its own because the queue
   policy already trusts the topic.
4. **Check.** Within a few minutes SQS, Monitoring, "Number of messages received" rises. "Send and
   receive messages", Poll for messages: every body is an SNS `Notification` whose `Message` holds
   one S3 record with a key starting with one of the four prefixes. Anything else means the filter
   policy was saved without the Message body scope.
5. **IAM user.** IAM, Users, Create user `inversa-goes-consumer`, no console access. Permissions:
   "Attach policies directly", Create policy, JSON, paste `iam-consumer-policy.json` with your
   account id, name it `inversa-goes-consumer`. After creation open the user, Security credentials,
   Create access key, use case "Application running outside AWS".
6. **Secrets.** On the API host set `GOES_SQS_URL=https://sqs.us-east-1.amazonaws.com/<account>/goes19-nodd`,
   `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` in the API's environment file and restart it.
   The log shows `goes object fetched` then `goes object decoded ... rows_in=<n>` once per object.

## CLI steps

Same result with the AWS CLI (a profile with admin rights on your account):

```sh
export AWS_REGION=us-east-1
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
TOPIC=arn:aws:sns:us-east-1:123901341784:NewGOES19Object

# 1-2. Queue with its access policy (the Policy attribute is the policy JSON as a string, so jq builds the file).
sed "s/YOUR_ACCOUNT_ID/$ACCOUNT/" deploy/aws/sqs-queue-policy.json > /tmp/queue-policy.json
jq -n --rawfile p /tmp/queue-policy.json \
  '{VisibilityTimeout:"300", MessageRetentionPeriod:"3600", ReceiveMessageWaitTimeSeconds:"20", Policy:$p}' \
  > /tmp/queue-attrs.json
QUEUE_URL=$(aws sqs create-queue --queue-name goes19-nodd --attributes file:///tmp/queue-attrs.json --query QueueUrl --output text)
QUEUE_ARN=$(aws sqs get-queue-attributes --queue-url "$QUEUE_URL" --attribute-names QueueArn --query Attributes.QueueArn --output text)

# 3. Subscription, raw delivery off (the default), body-scoped filter policy.
SUB_ARN=$(aws sns subscribe --topic-arn "$TOPIC" --protocol sqs --notification-endpoint "$QUEUE_ARN" \
  --attributes FilterPolicyScope=MessageBody --return-subscription-arn --query SubscriptionArn --output text)
aws sns set-subscription-attributes --subscription-arn "$SUB_ARN" \
  --attribute-name FilterPolicy --attribute-value file://deploy/aws/goes-filter-policy.json
aws sns get-subscription-attributes --subscription-arn "$SUB_ARN" \
  --query 'Attributes.[FilterPolicyScope,RawMessageDelivery,PendingConfirmation]'   # MessageBody, false, false

# 4. Check: after a few minutes, bodies carry only wanted keys.
aws sqs receive-message --queue-url "$QUEUE_URL" --max-number-of-messages 5 --wait-time-seconds 20 \
  --query 'Messages[].Body' --output text | grep -oE 'ABI-L2-[A-Z]+/[0-9/]+/OR_[A-Za-z0-9_.-]+' | head

# 5. IAM user limited to this queue.
sed "s/YOUR_ACCOUNT_ID/$ACCOUNT/" deploy/aws/iam-consumer-policy.json > /tmp/consumer-policy.json
aws iam create-user --user-name inversa-goes-consumer
aws iam put-user-policy --user-name inversa-goes-consumer --policy-name inversa-goes-consumer --policy-document file:///tmp/consumer-policy.json
aws iam create-access-key --user-name inversa-goes-consumer   # AccessKeyId + SecretAccessKey, shown once

# 6. Put QUEUE_URL and the key pair in the API environment as GOES_SQS_URL, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY.
```

Cost: NODD publishes roughly 3,000 GOES-19 objects an hour; the filter keeps about 40 an hour
(12 ACMC, 12 FDCC, 1 LSTC, 1 SSTF, plus mesoscale variants of none of them). The queue stays
inside the SQS free tier (1M requests a month) even with the 20 s long poll running all month
(about 130k receive calls).

## NetCDF/HDF5 build decision

GOES ABI L2 files are NetCDF4, which is HDF5 on disk with netCDF conventions on top. The
decoder (`api/src/ingest/push/goes/decode.rs`) uses the **`hdf5-metno` crate (0.15) with the
`static` feature** plus `hdf5-metno-sys` with `zlib`, and `ndarray` for hyperslab slices:

- No netcdf-c: the four products only need datasets, attributes and hyperslabs, which HDF5 gives
  directly; the netCDF layer would add a second C library for nothing.
- Static: `hdf5-metno-src` compiles HDF5 1.14 with CMake at build time and links it into the
  binary, so the API binary has no runtime dependency on a system libhdf5, and macOS dev and
  ubuntu-24.04 CI build the same way. The first build takes a few minutes; later builds are cached.
- zlib: ABI variables are deflate-chunked; without the filter every read fails with
  "filter not available".

Build prerequisites:

| Platform | Needed | Command |
|---|---|---|
| macOS (dev) | CMake, Xcode command line tools | `brew install cmake` (`brew install hdf5` is only for `h5dump` when inspecting fixtures) |
| ubuntu-24.04 (CI, prod builds) | CMake, a C compiler, zlib headers | `sudo apt-get install -y cmake build-essential zlib1g-dev` (GitHub's ubuntu-24.04 runner image has all three) |

No `libnetcdf-dev` or `libhdf5-dev` package is needed. If a distro-packaged HDF5 is ever
preferred, drop the `static` feature and set `HDF5_DIR=/usr` (Ubuntu: `apt install libhdf5-dev`).

## GOES grid and row volume

GOES readings land on a 0.05 deg grid over the PLAN C15 bbox: 68 x 64 = 4,352 cells, station
kind `goes_cell`, ext_id `g5:<col>:<row>` from the south-west corner (24.3N, 83.2W), station
lat/lon at the cell centre. Each cell averages the ABI pixels under a 4 x 4 sub-sample of the cell
(about eight 2 km pixels).

Rows are written only inside each product's domain, and inside it a cell is never dropped:

| Product | Domain (per pixel, from the file itself) | Row when no value |
|---|---|---|
| LSTC | land: `PQI` surface_type bits are land or snow/ice (inland water and the 192 class, which the open sea carries, are skipped) | `cloud` when PQI says probably cloudy or cloudy, else `bad_dqf` |
| SSTF | water: `DQF` 0, 1 or 2 (3 "unprocessed" is land) | `bad_dqf` (DQF 1 degraded, 2 severely degraded; cloudy water is 2) |
| FDCC | fire pixels only (`Mask` 10-15, 30-35) | no row |
| ACMC | cloudy pixels only (`BCM` 1), top-of-hour scan only | `cloud` rows on `lst_c` |

Measured on the fixtures (2026-09-26 18:01Z scene): LSTC window 175 x 152 pixels, 1,613 land
cells (1,550 with a value, 45 cloud, 18 bad_dqf); ACMC 1,267 cloud cells; FDCC 0 fires;
SSTF window 175 x 152 pixels, 2,833 water cells (2,267 with a value, 566 bad_dqf).
Rows per hourly scan set: 5,713, so about 137k rows a day against the 250k budget
(`goes_fixture_rows_per_scan_under_daily_budget` prints `GOES rows/scan N` and enforces it).

Readings precedence on a repeated key (`api/src/ingest/scheduler.rs`, the readings upsert): a null
never overwrites a value; between nulls `cloud` beats `bad_dqf` beats `missing`; between values
the newer write wins. So the LSTC row and the same-scan ACMC cloud row for one cell merge to the
better of the two whatever the arrival order.
