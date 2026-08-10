
-- Enums
CREATE TYPE public.app_role AS ENUM ('admin', 'user');
CREATE TYPE public.trader_profile AS ENUM ('intraday', 'scalper');
CREATE TYPE public.signal_direction AS ENUM ('long', 'short');
CREATE TYPE public.signal_status AS ENUM ('fresh', 'valid', 'late', 'invalidated', 'hit_tp1', 'hit_tp2', 'hit_sl');
CREATE TYPE public.strategy_category AS ENUM ('trend', 'momentum', 'mean_reversion', 'breakout', 'sr', 'harmonic', 'orderflow', 'session', 'volatility', 'ai');

-- Updated-at trigger fn
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

-- profiles
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT,
  display_name TEXT,
  avatar_url TEXT,
  trader_profile public.trader_profile NOT NULL DEFAULT 'intraday',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own profile select" ON public.profiles FOR SELECT TO authenticated USING (auth.uid() = id);
CREATE POLICY "own profile insert" ON public.profiles FOR INSERT TO authenticated WITH CHECK (auth.uid() = id);
CREATE POLICY "own profile update" ON public.profiles FOR UPDATE TO authenticated USING (auth.uid() = id) WITH CHECK (auth.uid() = id);
CREATE TRIGGER trg_profiles_updated BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- user_roles + has_role
CREATE TABLE public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.app_role NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, role)
);
GRANT SELECT ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own roles select" ON public.user_roles FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role public.app_role)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role);
$$;

-- Auto-create profile + default user role on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.profiles (id, email, display_name)
  VALUES (NEW.id, NEW.email, COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'name', split_part(NEW.email, '@', 1)));
  INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'user');
  RETURN NEW;
END;
$$;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- subscriptions (admin issues keys per email)
CREATE TABLE public.subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  subscription_key TEXT NOT NULL UNIQUE,
  tier TEXT NOT NULL DEFAULT 'pro',
  status TEXT NOT NULL DEFAULT 'active',
  expires_at TIMESTAMPTZ,
  redeemed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON public.subscriptions (email);
CREATE INDEX ON public.subscriptions (user_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.subscriptions TO authenticated;
GRANT ALL ON public.subscriptions TO service_role;
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own subs select" ON public.subscriptions FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR lower(email) = lower(coalesce((auth.jwt()->>'email'),'')) OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "admin subs write" ON public.subscriptions FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));
CREATE POLICY "self redeem update" ON public.subscriptions FOR UPDATE TO authenticated
  USING (lower(email) = lower(coalesce((auth.jwt()->>'email'),'')) AND user_id IS NULL)
  WITH CHECK (user_id = auth.uid());
CREATE TRIGGER trg_subs_updated BEFORE UPDATE ON public.subscriptions FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- strategies catalog (28 strategies)
CREATE TABLE public.strategies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category public.strategy_category NOT NULL,
  description TEXT NOT NULL,
  default_params JSONB NOT NULL DEFAULT '{}'::jsonb,
  timeframes TEXT[] NOT NULL DEFAULT ARRAY['M15','H1','H4'],
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT ON public.strategies TO authenticated;
GRANT ALL ON public.strategies TO service_role;
ALTER TABLE public.strategies ENABLE ROW LEVEL SECURITY;
CREATE POLICY "strategies read all" ON public.strategies FOR SELECT TO authenticated USING (true);
CREATE POLICY "strategies admin write" ON public.strategies FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin'));

-- per-user strategy settings
CREATE TABLE public.strategy_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  strategy_id TEXT NOT NULL REFERENCES public.strategies(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT true,
  params JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, strategy_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.strategy_settings TO authenticated;
GRANT ALL ON public.strategy_settings TO service_role;
ALTER TABLE public.strategy_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own strat settings" ON public.strategy_settings FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE TRIGGER trg_stratset_updated BEFORE UPDATE ON public.strategy_settings FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- signals
CREATE TABLE public.signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  pair TEXT NOT NULL,
  direction public.signal_direction NOT NULL,
  mode public.trader_profile NOT NULL DEFAULT 'intraday',
  timeframe TEXT NOT NULL,
  entry NUMERIC(18,6) NOT NULL,
  stop_loss NUMERIC(18,6) NOT NULL,
  take_profit_1 NUMERIC(18,6) NOT NULL,
  take_profit_2 NUMERIC(18,6) NOT NULL,
  atr NUMERIC(18,6) NOT NULL,
  confluence INTEGER NOT NULL CHECK (confluence BETWEEN 0 AND 100),
  contributing_strategies TEXT[] NOT NULL DEFAULT '{}',
  status public.signal_status NOT NULL DEFAULT 'fresh',
  rationale TEXT,
  news_context JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON public.signals (user_id, created_at DESC);
CREATE INDEX ON public.signals (status);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.signals TO authenticated;
GRANT ALL ON public.signals TO service_role;
ALTER TABLE public.signals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own signals" ON public.signals FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE TRIGGER trg_signals_updated BEFORE UPDATE ON public.signals FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- signal_events (audit)
CREATE TABLE public.signal_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  signal_id UUID NOT NULL REFERENCES public.signals(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON public.signal_events (signal_id, created_at DESC);
GRANT SELECT, INSERT ON public.signal_events TO authenticated;
GRANT ALL ON public.signal_events TO service_role;
ALTER TABLE public.signal_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own signal events" ON public.signal_events FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- ai_usage
CREATE TABLE public.ai_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  purpose TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd NUMERIC(12,6) NOT NULL DEFAULT 0,
  signal_id UUID REFERENCES public.signals(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON public.ai_usage (user_id, created_at DESC);
GRANT SELECT, INSERT ON public.ai_usage TO authenticated;
GRANT ALL ON public.ai_usage TO service_role;
ALTER TABLE public.ai_usage ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own ai usage" ON public.ai_usage FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- Seed 28 strategies catalog
INSERT INTO public.strategies (id, name, category, description, default_params, timeframes) VALUES
('ema_trend', 'EMA Trend Alignment', 'trend', 'Fast/slow EMA slope + price above/below stack across MTF.', '{"fast":21,"slow":55}', ARRAY['M15','H1','H4']),
('ichimoku', 'Ichimoku Cloud', 'trend', 'Price relative to Kumo, Tenkan/Kijun cross, Chikou confirmation.', '{}', ARRAY['H1','H4','D1']),
('supertrend', 'SuperTrend', 'trend', 'ATR-based directional flip.', '{"period":10,"multiplier":3}', ARRAY['M15','H1']),
('ma_ribbon', 'Moving Average Ribbon', 'trend', 'Fan of 8 EMAs; compression + expansion trigger.', '{}', ARRAY['H1','H4']),
('rsi_momo', 'RSI Momentum', 'momentum', 'RSI midline crosses + hidden divergence.', '{"period":14}', ARRAY['M15','H1']),
('macd_hist', 'MACD Histogram', 'momentum', 'Zero-line + histogram slope confirmation.', '{"fast":12,"slow":26,"signal":9}', ARRAY['H1','H4']),
('stoch_rsi', 'Stochastic RSI', 'momentum', 'OB/OS reversal with slope confirmation.', '{"period":14}', ARRAY['M5','M15']),
('cci_extreme', 'CCI Extreme Fade', 'mean_reversion', 'Fade > +200 / < -200 with S/R confluence.', '{"period":20}', ARRAY['M15','H1']),
('bollinger_squeeze', 'Bollinger Squeeze Break', 'breakout', 'Squeeze release with volume/ATR expansion.', '{"period":20,"stdev":2}', ARRAY['M15','H1']),
('keltner_break', 'Keltner Channel Break', 'breakout', 'ATR-channel break with momentum confirm.', '{}', ARRAY['H1','H4']),
('donchian_break', 'Donchian 20 Break', 'breakout', 'Classic 20-period high/low break.', '{"period":20}', ARRAY['H1','H4','D1']),
('atr_expansion', 'ATR Expansion', 'volatility', 'Directional impulse on ATR ratio expansion.', '{"period":14}', ARRAY['M15','H1']),
('vwap_mean_rev', 'VWAP Mean Reversion', 'mean_reversion', 'Distance from session VWAP > k*sigma.', '{}', ARRAY['M5','M15']),
('order_block', 'ICT Order Block', 'orderflow', 'Bullish/bearish OB retest with imbalance fill.', '{}', ARRAY['M15','H1','H4']),
('fvg', 'Fair Value Gap', 'orderflow', 'Imbalance zone retest.', '{}', ARRAY['M15','H1']),
('liquidity_sweep', 'Liquidity Sweep', 'orderflow', 'Sweep of prior swing high/low then reversal.', '{}', ARRAY['M15','H1']),
('bos_choch', 'BOS / CHoCH', 'orderflow', 'Break of structure / change of character detection.', '{}', ARRAY['M15','H1','H4']),
('sr_confluence', 'S/R Confluence', 'sr', 'Multi-touch horizontal levels with tolerance.', '{}', ARRAY['H1','H4','D1']),
('fib_retracement', 'Fibonacci Retracement', 'sr', '0.5/0.618/0.786 retracement with rejection.', '{}', ARRAY['H1','H4']),
('trendline_break', 'Trendline Break', 'sr', 'Sloped trendline break + retest.', '{}', ARRAY['H1','H4']),
('gartley', 'Gartley Harmonic', 'harmonic', 'Ratio-validated Gartley pattern.', '{}', ARRAY['H1','H4']),
('bat_pattern', 'Bat Harmonic', 'harmonic', 'Ratio-validated Bat pattern.', '{}', ARRAY['H1','H4']),
('butterfly_pattern', 'Butterfly Harmonic', 'harmonic', 'Ratio-validated Butterfly pattern.', '{}', ARRAY['H1','H4']),
('london_killzone', 'London Killzone', 'session', 'Bias inside London 07:00-10:00 UTC.', '{}', ARRAY['M15','H1']),
('ny_killzone', 'New York Killzone', 'session', 'Bias inside NY 12:00-15:00 UTC.', '{}', ARRAY['M15','H1']),
('asian_range', 'Asian Range Break', 'session', 'Range set 22:00-06:00 UTC, break at London open.', '{}', ARRAY['M15','H1']),
('news_reactive', 'News-Reactive Bias', 'ai', 'Bias adjustment from macro/news impact scoring.', '{}', ARRAY['M15','H1','H4']),
('ai_confluence', 'AI Multi-Signal Confluence', 'ai', 'LLM-assisted confluence overlay across enabled strategies.', '{}', ARRAY['M15','H1','H4']);
