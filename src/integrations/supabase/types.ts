export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5";
  };
  public: {
    Tables: {
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
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"];
          _user_id: string;
        };
        Returns: boolean;
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
