
-- update_updated_at helper (shared)
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql SET search_path = public;

-- profiles
CREATE TABLE public.profiles (
  id UUID NOT NULL PRIMARY KEY REFERENCES auth.users ON DELETE CASCADE,
  display_name TEXT,
  default_available_until TEXT NOT NULL DEFAULT '22:00',
  default_planning_mode TEXT NOT NULL DEFAULT 'custom',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own profile"
ON public.profiles FOR ALL
USING (auth.uid() = id) WITH CHECK (auth.uid() = id);

CREATE TRIGGER update_profiles_updated_at
BEFORE UPDATE ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- fixed_commitments
CREATE TABLE public.fixed_commitments (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users ON DELETE CASCADE,
  name TEXT NOT NULL,
  days_of_week INTEGER[] NOT NULL DEFAULT '{}', -- 0=Sun ... 6=Sat
  start_time TEXT NOT NULL, -- HH:MM
  end_time TEXT NOT NULL,   -- HH:MM
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.fixed_commitments TO authenticated;
GRANT ALL ON public.fixed_commitments TO service_role;

ALTER TABLE public.fixed_commitments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own commitments"
ON public.fixed_commitments FOR ALL
USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE INDEX fixed_commitments_user_idx ON public.fixed_commitments(user_id);

CREATE TRIGGER update_fixed_commitments_updated_at
BEFORE UPDATE ON public.fixed_commitments
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- auto-create empty profile row on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id) VALUES (NEW.id) ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
