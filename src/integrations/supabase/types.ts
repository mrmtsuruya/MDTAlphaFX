export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5";
  };
  public: {
    Tables: {
      // Added manually (2026-08-14): weekly walk-forward audit runs written
      // by the xauusd-strategy-audit edge function. Regenerate with
      // `supabase gen types typescript` once the CLI is linked to refresh
      // any other drift in this file.
      strategy_audit_runs: {
        Row: {
          id: string;
          run_id: string;
          user_id: string;
          pair: string;
          timeframe: string;
          strategy_id: string;
          segment: string;
          resolved: number;
          wins: number;
          scratches: number;
          losses: number;
          open: number;
          win_rate: number | null;
          total_r: number;
          expectancy_r: number | null;
          window_start: string;
          window_end: string;
          generated_at: string;
          notes: Json;
        };
        Insert: {
          id?: string;
          run_id: string;
          user_id: string;
          pair: string;
          timeframe: string;
          strategy_id: string;
          segment: string;
          resolved?: number;
          wins?: number;
          scratches?: number;
          losses?: number;
          open?: number;
          win_rate?: number | null;
          total_r?: number;
          expectancy_r?: number | null;
          window_start: string;
          window_end: string;
          generated_at?: string;
          notes?: Json;
        };
        Update: {
          id?: string;
          run_id?: string;
          user_id?: string;
          pair?: string;
          timeframe?: string;
          strategy_id?: string;
          segment?: string;
          resolved?: number;
          wins?: number;
          scratches?: number;
          losses?: number;
          open?: number;
          win_rate?: number | null;
          total_r?: number;
          expectancy_r?: number | null;
          window_start?: string;
          window_end?: string;
          generated_at?: string;
          notes?: Json;
        };
        Relationships: [
          {
            foreignKeyName: "strategy_audit_runs_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      // Added manually (2026-08-15): multiplier promotion ledger written by
      // the approve/revert server functions; the worker reads active rows.
      strategy_promotions: {
        Row: {
          id: string;
          user_id: string;
          strategy_id: string;
          mode: string;
          action: string;
          multiplier: number;
          resolved_samples: number;
          wins: number;
          losses: number;
          total_r: number;
          verdict: string;
          walk_weight: number | null;
          walk_accuracy: number | null;
          created_at: string;
          note: string | null;
        };
        Insert: {
          id?: string;
          user_id: string;
          strategy_id: string;
          mode: string;
          action: string;
          multiplier: number;
          resolved_samples: number;
          wins?: number;
          losses?: number;
          total_r?: number;
          verdict: string;
          walk_weight?: number | null;
          walk_accuracy?: number | null;
          created_at?: string;
          note?: string | null;
        };
        Update: {
          id?: string;
          user_id?: string;
          strategy_id?: string;
          mode?: string;
          action?: string;
          multiplier?: number;
          resolved_samples?: number;
          wins?: number;
          losses?: number;
          total_r?: number;
          verdict?: string;
          walk_weight?: number | null;
          walk_accuracy?: number | null;
          created_at?: string;
          note?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "strategy_promotions_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "strategy_promotions_strategy_id_fkey";
            columns: ["strategy_id"];
            isOneToOne: false;
            referencedRelation: "strategies";
            referencedColumns: ["id"];
          },
        ];
      };
      ai_usage: {
        Row: {
          cost_usd: number;
          created_at: string;
          id: string;
          input_tokens: number;
          model: string;
          output_tokens: number;
          purpose: string;
          signal_id: string | null;
          user_id: string;
        };
        Insert: {
          cost_usd?: number;
          created_at?: string;
          id?: string;
          input_tokens?: number;
          model: string;
          output_tokens?: number;
          purpose: string;
          signal_id?: string | null;
          user_id: string;
        };
        Update: {
          cost_usd?: number;
          created_at?: string;
          id?: string;
          input_tokens?: number;
          model?: string;
          output_tokens?: number;
          purpose?: string;
          signal_id?: string | null;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "ai_usage_signal_id_fkey";
            columns: ["signal_id"];
            isOneToOne: false;
            referencedRelation: "signals";
            referencedColumns: ["id"];
          },
        ];
      };
      market_snapshots: {
        Row: {
          ask: number | null;
          bid: number | null;
          candle_closed_at: string;
          candles: Json;
          content_hash: string;
          created_at: string;
          id: string;
          instrument: string;
          provider: string;
          provider_time: string | null;
          quality_result: Json;
          received_at: string | null;
          timeframe: string;
        };
        Insert: {
          ask?: number | null;
          bid?: number | null;
          candle_closed_at: string;
          candles: Json;
          content_hash: string;
          created_at?: string;
          id?: string;
          instrument: string;
          provider: string;
          provider_time?: string | null;
          quality_result: Json;
          received_at?: string | null;
          timeframe: string;
        };
        Update: {
          ask?: number | null;
          bid?: number | null;
          candle_closed_at?: string;
          candles?: Json;
          content_hash?: string;
          created_at?: string;
          id?: string;
          instrument?: string;
          provider?: string;
          provider_time?: string | null;
          quality_result?: Json;
          received_at?: string | null;
          timeframe?: string;
        };
        Relationships: [];
      };
      paper_trade_events: {
        Row: {
          after_state: Database["public"]["Enums"]["paper_trade_state"] | null;
          before_state: Database["public"]["Enums"]["paper_trade_state"] | null;
          created_at: string;
          evidence: Json;
          event_key: string;
          event_type: string;
          id: string;
          paper_trade_id: string;
          provider_timestamp: string | null;
          sequence_no: number;
          user_id: string;
          worker_timestamp: string;
        };
        Insert: {
          after_state?: Database["public"]["Enums"]["paper_trade_state"] | null;
          before_state?: Database["public"]["Enums"]["paper_trade_state"] | null;
          created_at?: string;
          evidence?: Json;
          event_key: string;
          event_type: string;
          id?: string;
          paper_trade_id: string;
          provider_timestamp?: string | null;
          sequence_no: number;
          user_id: string;
          worker_timestamp?: string;
        };
        Update: {
          after_state?: Database["public"]["Enums"]["paper_trade_state"] | null;
          before_state?: Database["public"]["Enums"]["paper_trade_state"] | null;
          created_at?: string;
          evidence?: Json;
          event_key?: string;
          event_type?: string;
          id?: string;
          paper_trade_id?: string;
          provider_timestamp?: string | null;
          sequence_no?: number;
          user_id?: string;
          worker_timestamp?: string;
        };
        Relationships: [
          {
            foreignKeyName: "paper_trade_events_paper_trade_id_fkey";
            columns: ["paper_trade_id"];
            isOneToOne: false;
            referencedRelation: "paper_trades";
            referencedColumns: ["id"];
          },
        ];
      };
      paper_trades: {
        Row: {
          ambiguous_intrabar: boolean;
          archived_at: string | null;
          bars_held: number;
          created_at: string;
          direction: Database["public"]["Enums"]["signal_direction"];
          entry_price: number | null;
          entry_time: string | null;
          execution_policy_version: string;
          exit_price: number | null;
          exit_time: string | null;
          expires_at: string;
          id: string;
          instrument_spec_version: string;
          last_observed_at: string | null;
          lot_size: number;
          mae_r: number | null;
          mfe_r: number | null;
          planned_entry: number;
          result_r: number | null;
          signal_id: string;
          state: Database["public"]["Enums"]["paper_trade_state"];
          state_version: number;
          stop_loss: number;
          symbol: string;
          take_profit_1: number;
          take_profit_2: number;
          timeframe: string;
          tp1_armed_at: string | null;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          ambiguous_intrabar?: boolean;
          archived_at?: string | null;
          bars_held?: number;
          created_at?: string;
          direction: Database["public"]["Enums"]["signal_direction"];
          entry_price?: number | null;
          entry_time?: string | null;
          execution_policy_version: string;
          exit_price?: number | null;
          exit_time?: string | null;
          expires_at: string;
          id?: string;
          instrument_spec_version: string;
          last_observed_at?: string | null;
          lot_size: number;
          mae_r?: number | null;
          mfe_r?: number | null;
          planned_entry: number;
          result_r?: number | null;
          signal_id: string;
          state: Database["public"]["Enums"]["paper_trade_state"];
          state_version?: number;
          stop_loss: number;
          symbol: string;
          take_profit_1: number;
          take_profit_2: number;
          timeframe: string;
          tp1_armed_at?: string | null;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          ambiguous_intrabar?: boolean;
          archived_at?: string | null;
          bars_held?: number;
          created_at?: string;
          direction?: Database["public"]["Enums"]["signal_direction"];
          entry_price?: number | null;
          entry_time?: string | null;
          execution_policy_version?: string;
          exit_price?: number | null;
          exit_time?: string | null;
          expires_at?: string;
          id?: string;
          instrument_spec_version?: string;
          last_observed_at?: string | null;
          lot_size?: number;
          mae_r?: number | null;
          mfe_r?: number | null;
          planned_entry?: number;
          result_r?: number | null;
          signal_id?: string;
          state?: Database["public"]["Enums"]["paper_trade_state"];
          state_version?: number;
          stop_loss?: number;
          symbol?: string;
          take_profit_1?: number;
          take_profit_2?: number;
          timeframe?: string;
          tp1_armed_at?: string | null;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "paper_trades_signal_id_fkey";
            columns: ["signal_id"];
            isOneToOne: true;
            referencedRelation: "signals";
            referencedColumns: ["id"];
          },
        ];
      };
      paper_trading_profiles: {
        Row: {
          activated_at: string | null;
          created_at: string;
          enabled: boolean;
          lot_size: number;
          strategy_scope: string;
          symbol: string;
          timezone: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          activated_at?: string | null;
          created_at?: string;
          enabled?: boolean;
          lot_size?: number;
          strategy_scope?: string;
          symbol?: string;
          timezone?: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          activated_at?: string | null;
          created_at?: string;
          enabled?: boolean;
          lot_size?: number;
          strategy_scope?: string;
          symbol?: string;
          timezone?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      paper_worker_health: {
        Row: {
          checked_at: string;
          code: string;
          detail: Json;
          id: string;
          instrument: string;
          ok: boolean;
          provider: string;
          quote_age_ms: number | null;
          quote_provider_time: string | null;
          spread: number | null;
        };
        Insert: {
          checked_at: string;
          code: string;
          detail?: Json;
          id?: string;
          instrument: string;
          ok: boolean;
          provider: string;
          quote_age_ms?: number | null;
          quote_provider_time?: string | null;
          spread?: number | null;
        };
        Update: {
          checked_at?: string;
          code?: string;
          detail?: Json;
          id?: string;
          instrument?: string;
          ok?: boolean;
          provider?: string;
          quote_age_ms?: number | null;
          quote_provider_time?: string | null;
          spread?: number | null;
        };
        Relationships: [];
      };
      profiles: {
        Row: {
          avatar_url: string | null;
          created_at: string;
          display_name: string | null;
          email: string | null;
          id: string;
          trader_profile: Database["public"]["Enums"]["trader_profile"];
          updated_at: string;
        };
        Insert: {
          avatar_url?: string | null;
          created_at?: string;
          display_name?: string | null;
          email?: string | null;
          id: string;
          trader_profile?: Database["public"]["Enums"]["trader_profile"];
          updated_at?: string;
        };
        Update: {
          avatar_url?: string | null;
          created_at?: string;
          display_name?: string | null;
          email?: string | null;
          id?: string;
          trader_profile?: Database["public"]["Enums"]["trader_profile"];
          updated_at?: string;
        };
        Relationships: [];
      };
      scan_runs: {
        Row: {
          candle_closed_at: string;
          created_at: string;
          engine_accounting: Json;
          engine_version: string;
          error_code: string | null;
          error_detail: string | null;
          finished_at: string | null;
          id: string;
          lease_expires_at: string | null;
          policy_version: string;
          quality_result: Json;
          scan_fingerprint: string;
          scan_mode: Database["public"]["Enums"]["trader_profile"];
          started_at: string | null;
          status: Database["public"]["Enums"]["paper_scan_status"];
          symbol: string;
          timeframe: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          candle_closed_at: string;
          created_at?: string;
          engine_accounting?: Json;
          engine_version: string;
          error_code?: string | null;
          error_detail?: string | null;
          finished_at?: string | null;
          id?: string;
          lease_expires_at?: string | null;
          policy_version: string;
          quality_result?: Json;
          scan_fingerprint: string;
          scan_mode: Database["public"]["Enums"]["trader_profile"];
          started_at?: string | null;
          status: Database["public"]["Enums"]["paper_scan_status"];
          symbol: string;
          timeframe: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          candle_closed_at?: string;
          created_at?: string;
          engine_accounting?: Json;
          engine_version?: string;
          error_code?: string | null;
          error_detail?: string | null;
          finished_at?: string | null;
          id?: string;
          lease_expires_at?: string | null;
          policy_version?: string;
          quality_result?: Json;
          scan_fingerprint?: string;
          scan_mode?: Database["public"]["Enums"]["trader_profile"];
          started_at?: string | null;
          status?: Database["public"]["Enums"]["paper_scan_status"];
          symbol?: string;
          timeframe?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      signal_events: {
        Row: {
          created_at: string;
          detail: Json;
          event: string;
          id: string;
          signal_id: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          detail?: Json;
          event: string;
          id?: string;
          signal_id: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          detail?: Json;
          event?: string;
          id?: string;
          signal_id?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "signal_events_signal_id_fkey";
            columns: ["signal_id"];
            isOneToOne: false;
            referencedRelation: "signals";
            referencedColumns: ["id"];
          },
        ];
      };
      signal_market_snapshots: {
        Row: {
          market_snapshot_id: string;
          role: string;
          signal_id: string;
        };
        Insert: {
          market_snapshot_id: string;
          role: string;
          signal_id: string;
        };
        Update: {
          market_snapshot_id?: string;
          role?: string;
          signal_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "signal_market_snapshots_market_snapshot_id_fkey";
            columns: ["market_snapshot_id"];
            isOneToOne: false;
            referencedRelation: "market_snapshots";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "signal_market_snapshots_signal_id_fkey";
            columns: ["signal_id"];
            isOneToOne: false;
            referencedRelation: "signals";
            referencedColumns: ["id"];
          },
        ];
      };
      signals: {
        Row: {
          archive_reason: string | null;
          archived_at: string | null;
          atr: number;
          confluence: number;
          contributing_strategies: string[];
          created_at: string;
          direction: Database["public"]["Enums"]["signal_direction"];
          engine_version: string | null;
          entry: number;
          execution_policy_version: string | null;
          expires_at: string;
          generated_by: string;
          id: string;
          market_snapshot_id: string | null;
          mode: Database["public"]["Enums"]["trader_profile"];
          news_context: Json;
          pair: string;
          policy_version: string | null;
          rationale: string | null;
          scan_fingerprint: string | null;
          scan_run_id: string | null;
          status: Database["public"]["Enums"]["signal_status"];
          stop_loss: number;
          take_profit_1: number;
          take_profit_2: number;
          timeframe: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          archive_reason?: string | null;
          archived_at?: string | null;
          atr: number;
          confluence: number;
          contributing_strategies?: string[];
          created_at?: string;
          direction: Database["public"]["Enums"]["signal_direction"];
          engine_version?: string | null;
          entry: number;
          execution_policy_version?: string | null;
          expires_at: string;
          generated_by?: string;
          id?: string;
          market_snapshot_id?: string | null;
          mode?: Database["public"]["Enums"]["trader_profile"];
          news_context?: Json;
          pair: string;
          policy_version?: string | null;
          rationale?: string | null;
          scan_fingerprint?: string | null;
          scan_run_id?: string | null;
          status?: Database["public"]["Enums"]["signal_status"];
          stop_loss: number;
          take_profit_1: number;
          take_profit_2: number;
          timeframe: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          archive_reason?: string | null;
          archived_at?: string | null;
          atr?: number;
          confluence?: number;
          contributing_strategies?: string[];
          created_at?: string;
          direction?: Database["public"]["Enums"]["signal_direction"];
          engine_version?: string | null;
          entry?: number;
          execution_policy_version?: string | null;
          expires_at?: string;
          generated_by?: string;
          id?: string;
          market_snapshot_id?: string | null;
          mode?: Database["public"]["Enums"]["trader_profile"];
          news_context?: Json;
          pair?: string;
          policy_version?: string | null;
          rationale?: string | null;
          scan_fingerprint?: string | null;
          scan_run_id?: string | null;
          status?: Database["public"]["Enums"]["signal_status"];
          stop_loss?: number;
          take_profit_1?: number;
          take_profit_2?: number;
          timeframe?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "signals_market_snapshot_id_fkey";
            columns: ["market_snapshot_id"];
            isOneToOne: false;
            referencedRelation: "market_snapshots";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "signals_scan_run_id_fkey";
            columns: ["scan_run_id"];
            isOneToOne: false;
            referencedRelation: "scan_runs";
            referencedColumns: ["id"];
          },
        ];
      };
      strategies: {
        Row: {
          category: Database["public"]["Enums"]["strategy_category"];
          created_at: string;
          default_params: Json;
          description: string;
          id: string;
          name: string;
          timeframes: string[];
        };
        Insert: {
          category: Database["public"]["Enums"]["strategy_category"];
          created_at?: string;
          default_params?: Json;
          description: string;
          id: string;
          name: string;
          timeframes?: string[];
        };
        Update: {
          category?: Database["public"]["Enums"]["strategy_category"];
          created_at?: string;
          default_params?: Json;
          description?: string;
          id?: string;
          name?: string;
          timeframes?: string[];
        };
        Relationships: [];
      };
      strategy_settings: {
        Row: {
          enabled: boolean;
          id: string;
          params: Json;
          strategy_id: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          enabled?: boolean;
          id?: string;
          params?: Json;
          strategy_id: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          enabled?: boolean;
          id?: string;
          params?: Json;
          strategy_id?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "strategy_settings_strategy_id_fkey";
            columns: ["strategy_id"];
            isOneToOne: false;
            referencedRelation: "strategies";
            referencedColumns: ["id"];
          },
        ];
      };
      subscriptions: {
        Row: {
          created_at: string;
          email: string;
          expires_at: string | null;
          id: string;
          redeemed_at: string | null;
          status: string;
          subscription_key: string;
          tier: string;
          updated_at: string;
          user_id: string | null;
        };
        Insert: {
          created_at?: string;
          email: string;
          expires_at?: string | null;
          id?: string;
          redeemed_at?: string | null;
          status?: string;
          subscription_key: string;
          tier?: string;
          updated_at?: string;
          user_id?: string | null;
        };
        Update: {
          created_at?: string;
          email?: string;
          expires_at?: string | null;
          id?: string;
          redeemed_at?: string | null;
          status?: string;
          subscription_key?: string;
          tier?: string;
          updated_at?: string;
          user_id?: string | null;
        };
        Relationships: [];
      };
      user_roles: {
        Row: {
          created_at: string;
          id: string;
          role: Database["public"]["Enums"]["app_role"];
          user_id: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          role: Database["public"]["Enums"]["app_role"];
          user_id: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          role?: Database["public"]["Enums"]["app_role"];
          user_id?: string;
        };
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      archive_xauusd_terminal_signals: {
        Args: {
          p_now: string;
        };
        Returns: number;
      };
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"];
          _user_id: string;
        };
        Returns: boolean;
      };
      set_xauusd_paper_enabled: {
        Args: {
          p_enabled: boolean;
        };
        Returns: undefined;
      };
      worker_apply_paper_transition: {
        Args: {
          p_after_state: Database["public"]["Enums"]["paper_trade_state"] | null;
          p_ambiguous_intrabar: boolean | null;
          p_bars_held: number | null;
          p_before_state: Database["public"]["Enums"]["paper_trade_state"] | null;
          p_entry_price: number | null;
          p_entry_time: string | null;
          p_evidence: Json;
          p_event_key: string;
          p_event_type: string;
          p_exit_price: number | null;
          p_exit_time: string | null;
          p_expected_state: Database["public"]["Enums"]["paper_trade_state"];
          p_expected_version: number;
          p_last_observed_at: string | null;
          p_mae_r: number | null;
          p_mfe_r: number | null;
          p_next_state: Database["public"]["Enums"]["paper_trade_state"];
          p_next_version: number;
          p_provider_timestamp: string | null;
          p_result_r: number | null;
          p_tp1_armed_at: string | null;
          p_trade_id: string;
        };
        Returns: boolean;
      };
      worker_claim_xauusd_scan: {
        Args: {
          p_candle_closed_at: string;
          p_engine_version: string;
          p_lease_expires_at: string;
          p_policy_version: string;
          p_scan_fingerprint: string;
          p_scan_mode: Database["public"]["Enums"]["trader_profile"];
          p_symbol: string;
          p_timeframe: string;
          p_user_id: string;
        };
        Returns: {
          scan_run_id: string;
          claimed: boolean;
        }[];
      };
      worker_commit_xauusd_scan: {
        Args: {
          p_engine_accounting: Json;
          p_engine_version: string;
          p_execution_policy_version: string;
          p_instrument_spec_version: string;
          p_policy_version: string;
          p_quality_result: Json;
          p_scan_fingerprint: string;
          p_scan_run_id: string;
          p_signal: Json;
          p_snapshots: Json;
          p_trade: Json;
          p_user_id: string;
        };
        Returns: {
          signal_id: string;
          paper_trade_id: string;
          created: boolean;
        }[];
      };
      worker_fail_xauusd_scan: {
        Args: {
          p_code: string;
          p_detail: string;
          p_engine_accounting: Json;
          p_scan_run_id: string;
          p_status: Database["public"]["Enums"]["paper_scan_status"];
        };
        Returns: undefined;
      };
      worker_record_xauusd_health: {
        Args: {
          p_checked_at: string;
          p_code: string;
          p_detail: Json;
          p_instrument: string;
          p_ok: boolean;
          p_provider: string;
          p_quote_age_ms: number | null;
          p_quote_provider_time: string | null;
          p_spread: number | null;
        };
        Returns: undefined;
      };
    };
    Enums: {
      app_role: "admin" | "user";
      paper_scan_status: "running" | "completed" | "degraded" | "failed";
      paper_trade_state:
        | "waiting_entry"
        | "open"
        | "tp1_protected"
        | "closed_tp2"
        | "closed_breakeven"
        | "closed_stop"
        | "expired";
      signal_direction: "long" | "short";
      signal_status: "fresh" | "valid" | "late" | "invalidated" | "hit_tp1" | "hit_tp2" | "hit_sl";
      strategy_category:
        | "trend"
        | "momentum"
        | "mean_reversion"
        | "breakout"
        | "sr"
        | "harmonic"
        | "orderflow"
        | "session"
        | "volatility"
        | "ai";
      trader_profile: "intraday" | "scalper";
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    keyof DefaultSchema["Enums"] | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    keyof DefaultSchema["CompositeTypes"] | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin", "user"],
      paper_scan_status: ["running", "completed", "degraded", "failed"],
      paper_trade_state: [
        "waiting_entry",
        "open",
        "tp1_protected",
        "closed_tp2",
        "closed_breakeven",
        "closed_stop",
        "expired",
      ],
      signal_direction: ["long", "short"],
      signal_status: ["fresh", "valid", "late", "invalidated", "hit_tp1", "hit_tp2", "hit_sl"],
      strategy_category: [
        "trend",
        "momentum",
        "mean_reversion",
        "breakout",
        "sr",
        "harmonic",
        "orderflow",
        "session",
        "volatility",
        "ai",
      ],
      trader_profile: ["intraday", "scalper"],
    },
  },
} as const;
