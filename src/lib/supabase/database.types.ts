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
  graphql_public: {
    Tables: {
      [_ in never]: never;
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      graphql: {
        Args: {
          extensions?: Json;
          operationName?: string;
          query?: string;
          variables?: Json;
        };
        Returns: Json;
      };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
  public: {
    Tables: {
      agents: {
        Row: {
          ai_model: string | null;
          created_at: string;
          elevenlabs_agent_id: string | null;
          id: string;
          knowledge_base_ids: string[];
          name: string;
          owner_id: string;
          prompt_environment: string | null;
          prompt_goal: string | null;
          prompt_guardrails: string | null;
          prompt_personality: string | null;
          prompt_tone: string | null;
          system_prompt: string | null;
          tools_enabled: Json;
          updated_at: string;
          voice_id: string | null;
        };
        Insert: {
          ai_model?: string | null;
          created_at?: string;
          elevenlabs_agent_id?: string | null;
          id?: string;
          knowledge_base_ids?: string[];
          name: string;
          owner_id: string;
          prompt_environment?: string | null;
          prompt_goal?: string | null;
          prompt_guardrails?: string | null;
          prompt_personality?: string | null;
          prompt_tone?: string | null;
          system_prompt?: string | null;
          tools_enabled?: Json;
          updated_at?: string;
          voice_id?: string | null;
        };
        Update: {
          ai_model?: string | null;
          created_at?: string;
          elevenlabs_agent_id?: string | null;
          id?: string;
          knowledge_base_ids?: string[];
          name?: string;
          owner_id?: string;
          prompt_environment?: string | null;
          prompt_goal?: string | null;
          prompt_guardrails?: string | null;
          prompt_personality?: string | null;
          prompt_tone?: string | null;
          system_prompt?: string | null;
          tools_enabled?: Json;
          updated_at?: string;
          voice_id?: string | null;
        };
        Relationships: [];
      };
      app_settings: {
        Row: {
          elevenlabs_api_key: string | null;
          elevenlabs_voice_ids: string | null;
          id: number;
          updated_at: string;
        };
        Insert: {
          elevenlabs_api_key?: string | null;
          elevenlabs_voice_ids?: string | null;
          id?: number;
          updated_at?: string;
        };
        Update: {
          elevenlabs_api_key?: string | null;
          elevenlabs_voice_ids?: string | null;
          id?: number;
          updated_at?: string;
        };
        Relationships: [];
      };
      callbacks: {
        Row: {
          campaign_id: string;
          created_at: string;
          created_by: string | null;
          id: string;
          lead_id: string;
          originating_call_id: string | null;
          result_call_id: string | null;
          scheduled_at: string;
          status: string;
        };
        Insert: {
          campaign_id: string;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          lead_id: string;
          originating_call_id?: string | null;
          result_call_id?: string | null;
          scheduled_at: string;
          status?: string;
        };
        Update: {
          campaign_id?: string;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          lead_id?: string;
          originating_call_id?: string | null;
          result_call_id?: string | null;
          scheduled_at?: string;
          status?: string;
        };
        Relationships: [
          {
            foreignKeyName: "callbacks_campaign_id_fkey";
            columns: ["campaign_id"];
            isOneToOne: false;
            referencedRelation: "campaigns";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "callbacks_campaign_id_fkey";
            columns: ["campaign_id"];
            isOneToOne: false;
            referencedRelation: "dial_queue";
            referencedColumns: ["campaign_id"];
          },
          {
            foreignKeyName: "callbacks_lead_id_fkey";
            columns: ["lead_id"];
            isOneToOne: false;
            referencedRelation: "dial_queue";
            referencedColumns: ["lead_id"];
          },
          {
            foreignKeyName: "callbacks_lead_id_fkey";
            columns: ["lead_id"];
            isOneToOne: false;
            referencedRelation: "leads";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "callbacks_originating_call_id_fkey";
            columns: ["originating_call_id"];
            isOneToOne: false;
            referencedRelation: "calls";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "callbacks_result_call_id_fkey";
            columns: ["result_call_id"];
            isOneToOne: false;
            referencedRelation: "calls";
            referencedColumns: ["id"];
          },
        ];
      };
      calls: {
        Row: {
          agent_id: string | null;
          answered_at: string | null;
          campaign_id: string;
          cost_breakdown: Json | null;
          created_at: string;
          direction: string;
          duration_seconds: number | null;
          elevenlabs_conversation_id: string | null;
          ended_at: string | null;
          extracted_data: Json | null;
          goal_met: boolean;
          id: string;
          lead_id: string;
          outcome: string | null;
          outcome_source: string | null;
          recording_path: string | null;
          retry_applied_at: string | null;
          score: number | null;
          started_at: string | null;
          status: string;
          summary: string | null;
          talk_time_seconds: number | null;
          transcript_json: Json | null;
          twilio_call_sid: string | null;
          twilio_number_id: string | null;
        };
        Insert: {
          agent_id?: string | null;
          answered_at?: string | null;
          campaign_id: string;
          cost_breakdown?: Json | null;
          created_at?: string;
          direction: string;
          duration_seconds?: number | null;
          elevenlabs_conversation_id?: string | null;
          ended_at?: string | null;
          extracted_data?: Json | null;
          goal_met?: boolean;
          id?: string;
          lead_id: string;
          outcome?: string | null;
          outcome_source?: string | null;
          recording_path?: string | null;
          retry_applied_at?: string | null;
          score?: number | null;
          started_at?: string | null;
          status?: string;
          summary?: string | null;
          talk_time_seconds?: number | null;
          transcript_json?: Json | null;
          twilio_call_sid?: string | null;
          twilio_number_id?: string | null;
        };
        Update: {
          agent_id?: string | null;
          answered_at?: string | null;
          campaign_id?: string;
          cost_breakdown?: Json | null;
          created_at?: string;
          direction?: string;
          duration_seconds?: number | null;
          elevenlabs_conversation_id?: string | null;
          ended_at?: string | null;
          extracted_data?: Json | null;
          goal_met?: boolean;
          id?: string;
          lead_id?: string;
          outcome?: string | null;
          outcome_source?: string | null;
          recording_path?: string | null;
          retry_applied_at?: string | null;
          score?: number | null;
          started_at?: string | null;
          status?: string;
          summary?: string | null;
          talk_time_seconds?: number | null;
          transcript_json?: Json | null;
          twilio_call_sid?: string | null;
          twilio_number_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "calls_agent_id_fkey";
            columns: ["agent_id"];
            isOneToOne: false;
            referencedRelation: "agents";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "calls_campaign_id_fkey";
            columns: ["campaign_id"];
            isOneToOne: false;
            referencedRelation: "campaigns";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "calls_campaign_id_fkey";
            columns: ["campaign_id"];
            isOneToOne: false;
            referencedRelation: "dial_queue";
            referencedColumns: ["campaign_id"];
          },
          {
            foreignKeyName: "calls_lead_id_fkey";
            columns: ["lead_id"];
            isOneToOne: false;
            referencedRelation: "dial_queue";
            referencedColumns: ["lead_id"];
          },
          {
            foreignKeyName: "calls_lead_id_fkey";
            columns: ["lead_id"];
            isOneToOne: false;
            referencedRelation: "leads";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "calls_twilio_number_id_fkey";
            columns: ["twilio_number_id"];
            isOneToOne: false;
            referencedRelation: "twilio_numbers";
            referencedColumns: ["id"];
          },
        ];
      };
      campaigns: {
        Row: {
          agent_id: string;
          calendly_event_id: string | null;
          calling_hours_end: string;
          calling_hours_start: string;
          calls_per_day_cap: number;
          calls_per_hour_cap: number;
          concurrency_cap_per_user: number;
          created_at: string;
          daily_spend_cap: number | null;
          description: string | null;
          email_template_id: string | null;
          ended_at: string | null;
          goal_id: string;
          id: string;
          monthly_spend_cap: number | null;
          name: string;
          owner_id: string;
          paused_at: string | null;
          paused_reason: string | null;
          status: string;
          transfer_destination_phone: string | null;
          twilio_number_id: string | null;
        };
        Insert: {
          agent_id: string;
          calendly_event_id?: string | null;
          calling_hours_end?: string;
          calling_hours_start?: string;
          calls_per_day_cap?: number;
          calls_per_hour_cap?: number;
          concurrency_cap_per_user?: number;
          created_at?: string;
          daily_spend_cap?: number | null;
          description?: string | null;
          email_template_id?: string | null;
          ended_at?: string | null;
          goal_id: string;
          id?: string;
          monthly_spend_cap?: number | null;
          name: string;
          owner_id: string;
          paused_at?: string | null;
          paused_reason?: string | null;
          status?: string;
          transfer_destination_phone?: string | null;
          twilio_number_id?: string | null;
        };
        Update: {
          agent_id?: string;
          calendly_event_id?: string | null;
          calling_hours_end?: string;
          calling_hours_start?: string;
          calls_per_day_cap?: number;
          calls_per_hour_cap?: number;
          concurrency_cap_per_user?: number;
          created_at?: string;
          daily_spend_cap?: number | null;
          description?: string | null;
          email_template_id?: string | null;
          ended_at?: string | null;
          goal_id?: string;
          id?: string;
          monthly_spend_cap?: number | null;
          name?: string;
          owner_id?: string;
          paused_at?: string | null;
          paused_reason?: string | null;
          status?: string;
          transfer_destination_phone?: string | null;
          twilio_number_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "campaigns_agent_id_fkey";
            columns: ["agent_id"];
            isOneToOne: false;
            referencedRelation: "agents";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "campaigns_goal_id_fkey";
            columns: ["goal_id"];
            isOneToOne: false;
            referencedRelation: "goals";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "campaigns_twilio_number_id_fkey";
            columns: ["twilio_number_id"];
            isOneToOne: false;
            referencedRelation: "twilio_numbers";
            referencedColumns: ["id"];
          },
        ];
      };
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
      dnc_entries: {
        Row: {
          added_at: string;
          added_by_user_id: string | null;
          company_snapshot: string | null;
          id: string;
          phone: string;
          reason: string;
          source_call_id: string | null;
        };
        Insert: {
          added_at?: string;
          added_by_user_id?: string | null;
          company_snapshot?: string | null;
          id?: string;
          phone: string;
          reason: string;
          source_call_id?: string | null;
        };
        Update: {
          added_at?: string;
          added_by_user_id?: string | null;
          company_snapshot?: string | null;
          id?: string;
          phone?: string;
          reason?: string;
          source_call_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "dnc_entries_source_call_id_fkey";
            columns: ["source_call_id"];
            isOneToOne: false;
            referencedRelation: "calls";
            referencedColumns: ["id"];
          },
        ];
      };
      dnc_removals: {
        Row: {
          id: string;
          phone: string;
          reason_text: string;
          removed_at: string;
          removed_by_user_id: string;
        };
        Insert: {
          id?: string;
          phone: string;
          reason_text: string;
          removed_at?: string;
          removed_by_user_id: string;
        };
        Update: {
          id?: string;
          phone?: string;
          reason_text?: string;
          removed_at?: string;
          removed_by_user_id?: string;
        };
        Relationships: [];
      };
      elevenlabs_webhook_events: {
        Row: {
          conversation_id: string;
          raw_payload: Json | null;
          received_at: string;
        };
        Insert: {
          conversation_id: string;
          raw_payload?: Json | null;
          received_at?: string;
        };
        Update: {
          conversation_id?: string;
          raw_payload?: Json | null;
          received_at?: string;
        };
        Relationships: [];
      };
      goals: {
        Row: {
          created_at: string;
          description: string | null;
          id: string;
          is_default: boolean;
          name: string;
          owner_id: string;
        };
        Insert: {
          created_at?: string;
          description?: string | null;
          id?: string;
          is_default?: boolean;
          name: string;
          owner_id: string;
        };
        Update: {
          created_at?: string;
          description?: string | null;
          id?: string;
          is_default?: boolean;
          name?: string;
          owner_id?: string;
        };
        Relationships: [];
      };
      knowledge_base_sources: {
        Row: {
          created_at: string;
          file_path: string | null;
          id: string;
          kb_id: string;
          synced_at: string | null;
          type: string;
          url: string | null;
        };
        Insert: {
          created_at?: string;
          file_path?: string | null;
          id?: string;
          kb_id: string;
          synced_at?: string | null;
          type: string;
          url?: string | null;
        };
        Update: {
          created_at?: string;
          file_path?: string | null;
          id?: string;
          kb_id?: string;
          synced_at?: string | null;
          type?: string;
          url?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "knowledge_base_sources_kb_id_fkey";
            columns: ["kb_id"];
            isOneToOne: false;
            referencedRelation: "knowledge_bases";
            referencedColumns: ["id"];
          },
        ];
      };
      knowledge_bases: {
        Row: {
          created_at: string;
          description: string | null;
          elevenlabs_kb_id: string | null;
          id: string;
          name: string;
          owner_id: string;
        };
        Insert: {
          created_at?: string;
          description?: string | null;
          elevenlabs_kb_id?: string | null;
          id?: string;
          name: string;
          owner_id: string;
        };
        Update: {
          created_at?: string;
          description?: string | null;
          elevenlabs_kb_id?: string | null;
          id?: string;
          name?: string;
          owner_id?: string;
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
            referencedRelation: "dial_queue";
            referencedColumns: ["lead_id"];
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
      list_campaign_attachments: {
        Row: {
          attached_at: string;
          campaign_id: string;
          detached_at: string | null;
          id: string;
          list_id: string;
        };
        Insert: {
          attached_at?: string;
          campaign_id: string;
          detached_at?: string | null;
          id?: string;
          list_id: string;
        };
        Update: {
          attached_at?: string;
          campaign_id?: string;
          detached_at?: string | null;
          id?: string;
          list_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "list_campaign_attachments_campaign_id_fkey";
            columns: ["campaign_id"];
            isOneToOne: false;
            referencedRelation: "campaigns";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "list_campaign_attachments_campaign_id_fkey";
            columns: ["campaign_id"];
            isOneToOne: false;
            referencedRelation: "dial_queue";
            referencedColumns: ["campaign_id"];
          },
          {
            foreignKeyName: "list_campaign_attachments_list_id_fkey";
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
          is_inbound_default: boolean;
          name: string;
          owner_id: string;
        };
        Insert: {
          created_at?: string;
          description?: string | null;
          id?: string;
          is_inbound_default?: boolean;
          name: string;
          owner_id: string;
        };
        Update: {
          created_at?: string;
          description?: string | null;
          id?: string;
          is_inbound_default?: boolean;
          name?: string;
          owner_id?: string;
        };
        Relationships: [];
      };
      notifications: {
        Row: {
          created_at: string;
          id: string;
          kind: string;
          message: string;
          read_at: string | null;
          ref_id: string | null;
          ref_table: string | null;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          kind: string;
          message: string;
          read_at?: string | null;
          ref_id?: string | null;
          ref_table?: string | null;
          user_id: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          kind?: string;
          message?: string;
          read_at?: string | null;
          ref_id?: string | null;
          ref_table?: string | null;
          user_id?: string;
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
      saved_views: {
        Row: {
          created_at: string;
          id: string;
          name: string;
          page: string;
          params: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          name: string;
          page: string;
          params?: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          name?: string;
          page?: string;
          params?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      system_events: {
        Row: {
          actor_user_id: string | null;
          created_at: string;
          id: string;
          kind: string;
          payload: Json | null;
          ref_id: string | null;
          ref_table: string | null;
        };
        Insert: {
          actor_user_id?: string | null;
          created_at?: string;
          id?: string;
          kind: string;
          payload?: Json | null;
          ref_id?: string | null;
          ref_table?: string | null;
        };
        Update: {
          actor_user_id?: string | null;
          created_at?: string;
          id?: string;
          kind?: string;
          payload?: Json | null;
          ref_id?: string | null;
          ref_table?: string | null;
        };
        Relationships: [];
      };
      twilio_numbers: {
        Row: {
          attached_campaign_id: string | null;
          country: string;
          flagged_for_rotation: boolean;
          friendly_name: string | null;
          id: string;
          last_calls_count_24h: number;
          last_connect_rate_24h: number | null;
          last_connect_rate_check_at: string | null;
          monthly_cost: number;
          phone_number: string;
          purchased_at: string;
          released_at: string | null;
          twilio_sid: string | null;
        };
        Insert: {
          attached_campaign_id?: string | null;
          country: string;
          flagged_for_rotation?: boolean;
          friendly_name?: string | null;
          id?: string;
          last_calls_count_24h?: number;
          last_connect_rate_24h?: number | null;
          last_connect_rate_check_at?: string | null;
          monthly_cost?: number;
          phone_number: string;
          purchased_at?: string;
          released_at?: string | null;
          twilio_sid?: string | null;
        };
        Update: {
          attached_campaign_id?: string | null;
          country?: string;
          flagged_for_rotation?: boolean;
          friendly_name?: string | null;
          id?: string;
          last_calls_count_24h?: number;
          last_connect_rate_24h?: number | null;
          last_connect_rate_check_at?: string | null;
          monthly_cost?: number;
          phone_number?: string;
          purchased_at?: string;
          released_at?: string | null;
          twilio_sid?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "twilio_numbers_attached_campaign_fk";
            columns: ["attached_campaign_id"];
            isOneToOne: false;
            referencedRelation: "campaigns";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "twilio_numbers_attached_campaign_fk";
            columns: ["attached_campaign_id"];
            isOneToOne: false;
            referencedRelation: "dial_queue";
            referencedColumns: ["campaign_id"];
          },
        ];
      };
      twilio_status_events: {
        Row: {
          call_sid: string;
          event_type: string;
          raw_payload: Json | null;
          received_at: string;
        };
        Insert: {
          call_sid: string;
          event_type: string;
          raw_payload?: Json | null;
          received_at?: string;
        };
        Update: {
          call_sid?: string;
          event_type?: string;
          raw_payload?: Json | null;
          received_at?: string;
        };
        Relationships: [];
      };
    };
    Views: {
      dial_queue: {
        Row: {
          agent_id: string | null;
          business_phone: string | null;
          calling_hours_end: string | null;
          calling_hours_start: string | null;
          calls_per_day_cap: number | null;
          calls_per_hour_cap: number | null;
          campaign_id: string | null;
          concurrency_cap_per_user: number | null;
          daily_spend_cap: number | null;
          lead_id: string | null;
          lead_timezone: string | null;
          monthly_spend_cap: number | null;
          next_call_at: string | null;
          owner_id: string | null;
          twilio_number_id: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "campaigns_agent_id_fkey";
            columns: ["agent_id"];
            isOneToOne: false;
            referencedRelation: "agents";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "campaigns_twilio_number_id_fkey";
            columns: ["twilio_number_id"];
            isOneToOne: false;
            referencedRelation: "twilio_numbers";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    Functions: {
      elevenlabs_voice_ids: { Args: never; Returns: string };
      expire_resting_leads: { Args: never; Returns: number };
      get_or_create_inbound_list: {
        Args: { in_owner: string };
        Returns: string;
      };
      is_admin: { Args: { uid: string }; Returns: boolean };
      is_phone_on_dnc: { Args: { phone_to_check: string }; Returns: boolean };
      is_within_calling_hours: {
        Args: { hours_end: string; hours_start: string; lead_timezone: string };
        Returns: boolean;
      };
      monitor_campaign_spend_caps: { Args: never; Returns: number };
      monitor_twilio_connect_rates: { Args: never; Returns: number };
      pre_call_check: {
        Args: { in_campaign_id: string; in_lead_id: string };
        Returns: string;
      };
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
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const;
