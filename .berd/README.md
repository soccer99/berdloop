# .berd/

Berdloop runs several agents on this project at once. Each one gets its own
copy of the repository, so their files never collide. This directory is how
they avoid colliding on everything else: ports, databases and env files.

**Nothing outside this directory was changed.** Your own setup still runs
exactly as it did, on its normal ports, against your normal database. Slot 0 is
yours and is never given to a worker.

## config.json

| Field | What it decides |
| --- | --- |
| `ports` | Where the per-worker port blocks start, and how wide each is. |
| `services` | Each thing that binds a port, and the variable it reads. |
| `dev.command` | How to start the app. Run with the worker's own ports. |
| `resources` | The databases and caches, and how each worker gets its own. |
| `compose` | Set only if you use Docker. Most projects do not need it. |
| `env` | Which env files to write in a worker's copy, and what goes in them. |
| `limits` | How many apps may run at once, and when an idle one stops. |

Every field may be left out. A project with no `dev.command` simply never has
an app started for it. A project with no `resources` gets ports and nothing
else. Neither case is an error.

## Ports

Each worker holds a slot, which is a small number. A port is
`base + slot * stride + offset`, so it is the same every time and two workers
can never be given the same one.

Berdloop checks the whole block binds before it hands it over. If something
else holds a port in it, the worker moves to the next free block. A single port
is never moved on its own, because then nothing else would know where it went.

## Databases

Engines are a tier above the app. Berdloop does not start one per worker: it
uses the servers you already have and gives each worker its own database inside
them.

```
  your postgres, your redis, your mongo      one set, shared
            |            |          |
       app_wt1       wt1:*      docs_wt1     one tenant per worker
```

A project may declare as many resources as it needs. Postgres and Redis, or
Postgres and Mongo and DuckDB, are all ordinary. Each one says how a worker is
kept apart:

| `tenancy` | What each worker gets | Good for |
| --- | --- | --- |
| `database` | Its own database on your server. | Postgres, MySQL, Mongo |
| `schema` | Its own schema in one database. | Postgres |
| `prefix` | Its own key prefix. | Redis |
| `file` | Its own file. | SQLite, DuckDB |
| `none` | Nothing. The engine is shared. | A read-only engine |

**Docker is not required and is never assumed.** A Postgres installed with
Homebrew, or a server you start yourself, is the normal case: leave `start`
empty and Berdloop will probe it, find it running, and leave it alone. Set
`start` only for an engine you want Berdloop to bring up.

**Add your migration command** to each resource's `migrate`, and any fixtures
to `seed`. Without them a worker's database is empty, which is rarely what you
want. They run in the worker's own copy, with its own connection strings, after
its database exists.

Berdloop never copies your database. PostgreSQL refuses to copy one while
anything is connected to it, and the thing connected is usually your own app;
making that work would mean closing your connections. An empty database plus
your migrations is slower to build and always correct.

### Connection details

Berdloop keeps the admin connection string for each engine in its own data
directory, not here and not in any worker's copy. This file is committed, so a
password must never be written into it, and a worker that could make its own
database would need credentials an agent would then read.

Change them in the project's settings, not in this file.

## Secrets

Berdloop copies a value into a worker only from a file git tracks, such as
`.env.example`. Anything your team already committed is not a secret.

Keys it finds only in your untracked `.env` are carried over **by name**, with
a generated stand-in value. Your real values are never copied into a worker and
never reach an agent.

If a task genuinely needs a real credential, put it in `env.values` yourself,
and know that the agent will be able to read it.

## Config files that are not env files

Some projects keep ports and database names in `config/database.yml`,
`application.yml` or `appsettings.json` rather than the environment. Berdloop
does not edit files like that, because editing them is a code change.

Use the escape hatch instead: if `.berd/dev` exists and is executable, Berdloop
runs it in place of `dev.command`, with the worker's environment. Render or
patch whatever your stack needs at the top of that script, reading `$PORT` and
the connection strings from the environment, then start the app.

## If you use Docker

Set `compose.file` and each worker gets its own `COMPOSE_PROJECT_NAME`, so
containers, networks and volumes never collide. Host ports in that file must
read from the environment:

```yaml
services:
  web:
    ports:
      - "${PORT:-3000}:3000"
```

A fixed host port, a `container_name:` or `network_mode: host` will still
collide, whatever Berdloop does.
