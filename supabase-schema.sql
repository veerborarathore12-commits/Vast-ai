-- Run this once in Supabase: SQL Editor > New query > Run.
-- Vast stores all account data server-side in this private table.
create table if not exists public.vast_state (
  id text primary key,
  users jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

-- The browser never receives the Supabase service-role key. Keep direct access closed.
alter table public.vast_state enable row level security;

-- Private image storage for Nano Banana output. Vast serves each image only to its owner.
insert into storage.buckets (id, name, public)
values ('vast-images', 'vast-images', false)
on conflict (id) do nothing;
