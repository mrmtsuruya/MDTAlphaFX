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
      signals: {
        Row: {
          atr: number;
          confluence: number;
          contributing_strategies: string[];
          created_at: string;
          direction: Database["public"]["Enums"]["signal_direction"];
          entry: number;
          expires_at: string;
          id: string;
          mode: Database["public"]["Enums"]["trader_profile"];
          news_context: Json;
          pair: string;
          rationale: string | null;
          status: Database["public"]["Enums"]["signal_status"];
          stop_loss: number;
          take_profit_1: number;
          take_profit_2: number;
          timeframe: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          atr: number;
          confluence: number;
          contributing_strategies?: string[];
          created_at?: string;
          direction: Database["public"]["Enums"]["signal_direction"];
          entry: number;
          expires_at: string;
          id?: string;
          mode?: Database["public"]["Enums"]["trader_profile"];
          news_context?: Json;
          pair: string;
          rationale?: string | null;
          status?: Database["public"]["Enums"]["signal_status"];
          stop_loss: number;
          take_profit_1: number;
          take_profit_2: number;
          timeframe: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          atr?: number;
          confluence?: number;
          contributing_strategies?: string[];
          created_at?: string;
          direction?: Database["public"]["Enums"]["signal_direction"];
          entry?: number;
          expires_at?: string;
          id?: string;
          mode?: Database["public"]["Enums"]["trader_profile"];
          news_context?: Json;
          pair?: string;
          rationale?: string | null;
          status?: Database["public"]["Enums"]["signal_status"];
          stop_loss?: number;
          take_profit_1?: number;
          take_profit_2?: number;
          timeframe?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
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
