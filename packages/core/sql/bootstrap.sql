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
  provider_allowlist text[] not null default '{}',
  primary key (guild_id, channel_id)
);

create table if not exists provider_configs (
  provider_name text primary key,
  enabled boolean not null default false,
  config_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists jobs (
  id uuid primary key,
  command_name text not null,
  state text not null,
  provider_name text not null,
  requester_discord_id text not null,
  guild_id text,
  channel_id text not null,
  prompt text not null,
  context_json jsonb not null,
  summary text,
  final_response text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists job_approvals (
  id bigserial primary key,
  job_id uuid not null references jobs(id) on delete cascade,
  stage text not null,
  status text not null,
  actor_discord_id text not null,
  reason text,
  created_at timestamptz not null default now()
);

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
  id bigserial primary key,
  job_id uuid references jobs(id) on delete set null,
  actor_discord_id text,
  event_type text not null,
  event_json jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists message_archives (
  message_id text primary key,
  guild_id text,
  channel_id text not null,
  author_discord_id text not null,
  content text not null,
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null
);

create table if not exists embedding_chunks (
  chunk_id text primary key,
  message_id text not null references message_archives(message_id) on delete cascade,
  text_content text not null,
  metadata_json jsonb not null default '{}'::jsonb,
  embedding vector(1536)
);

create table if not exists style_packs (
  name text primary key,
  file_path text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
