create table if not exists guild_configs (
  guild_id text primary key,
  default_style_pack text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists channel_policies (
  guild_id text not null,
  channel_id text not null,
  indexing_enabled boolean not null default false,
  provider_allowlist text[] not null default '{}'::text[],
  primary key (guild_id, channel_id)
);

create table if not exists provider_configs (
  provider_name text primary key,
  enabled boolean not null default false,
  config_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists style_packs (
  name text primary key,
  file_path text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists state_migrations (
  name text primary key,
  applied_at timestamptz not null default now()
);

create table if not exists jobs (
  id uuid primary key,
  request_message_id text,
  command_name text not null,
  state text not null,
  provider_name text not null,
  requester_discord_id text not null,
  guild_id text,
  output_channel_id text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  job_json jsonb not null
);

create index if not exists jobs_state_created_idx
  on jobs (state, created_at);

create unique index if not exists jobs_request_dedupe_idx
  on jobs (request_message_id, command_name, provider_name, output_channel_id)
  where request_message_id is not null;

create table if not exists provider_runs (
  id bigserial primary key,
  job_id uuid not null references jobs(id) on delete cascade,
  provider_name text not null,
  request_json jsonb not null,
  response_json jsonb,
  created_at timestamptz not null default now()
);

create table if not exists tool_invocations (
  id bigserial primary key,
  job_id uuid references jobs(id) on delete cascade,
  sandbox_profile text not null,
  tool_name text not null,
  request_json jsonb not null,
  result_json jsonb,
  created_at timestamptz not null default now()
);

create table if not exists audit_events (
  id uuid primary key,
  job_id uuid references jobs(id) on delete set null,
  actor_discord_id text,
  provider_name text,
  event_type text not null,
  event_timestamp timestamptz not null default now(),
  event_json jsonb not null
);

create index if not exists audit_events_job_timestamp_idx
  on audit_events (job_id, event_timestamp desc);

create table if not exists interaction_memory_events (
  id text primary key,
  actor_id text not null,
  actor_name text not null,
  source_kind text not null,
  guild_id text,
  channel_id text not null,
  channel_name text,
  command_name text,
  prompt text not null,
  excerpt text not null,
  summary text not null,
  sentiment text not null,
  score integer not null,
  tags text[] not null default '{}'::text[],
  event_timestamp timestamptz not null,
  event_json jsonb not null
);

create index if not exists interaction_memory_events_actor_timestamp_idx
  on interaction_memory_events (actor_id, event_timestamp desc);
