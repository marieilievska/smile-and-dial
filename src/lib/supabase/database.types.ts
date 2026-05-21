export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5";
  };
  public: {
    Tables: {
      custom_field_defs: {
        Row: {
          created_at: string;
          id: string;
          name: string;
          options: Json;
          required: boolean;
          slug: string;
          sort_order: number;
          type: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          name: string;
          options?: Json;
          required?: boolean;
          slug: string;
          sort_order?: number;
          type: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          name?: string;
          options?: Json;
          required?: boolean;
          slug?: string;
          sort_order?: number;
          type?: string;
        };
        Relationships: [];
      };
      lead_custom_values: {
        Row: {
          custom_field_id: string;
          lead_id: string;
          value: Json | null;
        };
        Insert: {
          custom_field_id: string;
          lead_id: string;
          value?: Json | null;
        };
        Update: {
          custom_field_id?: string;
          lead_id?: string;
          value?: Json | null;
        };
        Relationships: [
          {
            foreignKeyName: "lead_custom_values_custom_field_id_fkey";
            columns: ["custom_field_id"];
            isOneToOne: false;
            referencedRelation: "custom_field_defs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "lead_custom_values_lead_id_fkey";
            columns: ["lead_id"];
            isOneToOne: false;
            referencedRelation: "leads";
            referencedColumns: ["id"];
          },
        ];
      };
      leads: {
        Row: {
          ai_summary: string | null;
          business_email: string | null;
          business_phone: string | null;
          call_attempts: number;
          category: string | null;
          city: string | null;
          company: string | null;
          conversations: number;
          created_at: string;
          deleted_at: string | null;
          employee_name: string | null;
          google_place_id: string | null;
          google_rating: number | null;
          google_reviews: number | null;
          id: string;
          last_call_at: string | null;
          last_outcome: string | null;
          list_id: string;
          manager_name: string | null;
          next_call_at: string | null;
          owner_id: string;
          owner_name: string | null;
          owner_phone: string | null;
          resting_until: string | null;
          retry_counter: number;
          retry_position: number;
          state: string | null;
          status: string;
          timezone: string | null;
          updated_at: string;
          utm_campaign: string | null;
          website: string | null;
        };
        Insert: {
          ai_summary?: string | null;
          business_email?: string | null;
          business_phone?: string | null;
          call_attempts?: number;
          category?: string | null;
          city?: string | null;
          company?: string | null;
          conversations?: number;
          created_at?: string;
          deleted_at?: string | null;
          employee_name?: string | null;
          google_place_id?: string | null;
          google_rating?: number | null;
          google_reviews?: number | null;
          id?: string;
          last_call_at?: string | null;
          last_outcome?: string | null;
          list_id: string;
          manager_name?: string | null;
          next_call_at?: string | null;
          owner_id: string;
          owner_name?: string | null;
          owner_phone?: string | null;
          resting_until?: string | null;
          retry_counter?: number;
          retry_position?: number;
          state?: string | null;
          status?: string;
          timezone?: string | null;
          updated_at?: string;
          utm_campaign?: string | null;
          website?: string | null;
        };
        Update: {
          ai_summary?: string | null;
          business_email?: string | null;
          business_phone?: string | null;
          call_attempts?: number;
          category?: string | null;
          city?: string | null;
          company?: string | null;
          conversations?: number;
          created_at?: string;
          deleted_at?: string | null;
          employee_name?: string | null;
          google_place_id?: string | null;
          google_rating?: number | null;
          google_reviews?: number | null;
          id?: string;
          last_call_at?: string | null;
          last_outcome?: string | null;
          list_id?: string;
          manager_name?: string | null;
          next_call_at?: string | null;
          owner_id?: string;
          owner_name?: string | null;
          owner_phone?: string | null;
          resting_until?: string | null;
          retry_counter?: number;
          retry_position?: number;
          state?: string | null;
          status?: string;
          timezone?: string | null;
          updated_at?: string;
          utm_campaign?: string | null;
          website?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "leads_list_id_fkey";
            columns: ["list_id"];
            isOneToOne: false;
            referencedRelation: "lists";
            referencedColumns: ["id"];
          },
        ];
      };
      lists: {
        Row: {
          created_at: string;
          description: string | null;
          id: string;
          name: string;
          owner_id: string;
        };
        Insert: {
          created_at?: string;
          description?: string | null;
          id?: string;
          name: string;
          owner_id: string;
        };
        Update: {
          created_at?: string;
          description?: string | null;
          id?: string;
          name?: string;
          owner_id?: string;
        };
        Relationships: [];
      };
      profiles: {
        Row: {
          active: boolean;
          avatar_url: string | null;
          created_at: string;
          email: string | null;
          full_name: string | null;
          id: string;
          last_login_at: string | null;
          notify_on_email_reply: boolean;
          notify_on_goal_met: boolean;
          role: string;
        };
        Insert: {
          active?: boolean;
          avatar_url?: string | null;
          created_at?: string;
          email?: string | null;
          full_name?: string | null;
          id: string;
          last_login_at?: string | null;
          notify_on_email_reply?: boolean;
          notify_on_goal_met?: boolean;
          role?: string;
        };
        Update: {
          active?: boolean;
          avatar_url?: string | null;
          created_at?: string;
          email?: string | null;
          full_name?: string | null;
          id?: string;
          last_login_at?: string | null;
          notify_on_email_reply?: boolean;
          notify_on_goal_met?: boolean;
          role?: string;
        };
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      is_admin: { Args: { uid: string }; Returns: boolean };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">;

type DefaultSchema = DatabaseWithoutInternals[Extract<
  keyof Database,
  "public"
>];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  public: {
    Enums: {},
  },
} as const;
