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
          externally_managed: boolean;
          extra_data_collection: Json;
          extra_evaluation: Json;
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
          externally_managed?: boolean;
          extra_data_collection?: Json;
          extra_evaluation?: Json;
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
          externally_managed?: boolean;
          extra_data_collection?: Json;
          extra_evaluation?: Json;
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
      api_idempotency_keys: {
        Row: {
          api_key_id: string;
          created_at: string;
          id: string;
          idempotency_key: string;
          lead_id: string | null;
          response: Json;
        };
        Insert: {
          api_key_id: string;
          created_at?: string;
          id?: string;
          idempotency_key: string;
          lead_id?: string | null;
          response: Json;
        };
        Update: {
          api_key_id?: string;
          created_at?: string;
          id?: string;
          idempotency_key?: string;
          lead_id?: string | null;
          response?: Json;
        };
        Relationships: [
          {
            foreignKeyName: "api_idempotency_keys_api_key_id_fkey";
            columns: ["api_key_id"];
            isOneToOne: false;
            referencedRelation: "api_keys";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "api_idempotency_keys_lead_id_fkey";
            columns: ["lead_id"];
            isOneToOne: false;
            referencedRelation: "dial_queue";
            referencedColumns: ["lead_id"];
          },
          {
            foreignKeyName: "api_idempotency_keys_lead_id_fkey";
            columns: ["lead_id"];
            isOneToOne: false;
            referencedRelation: "leads";
            referencedColumns: ["id"];
          },
        ];
      };
      api_keys: {
        Row: {
          created_at: string;
          id: string;
          key_hash: string;
          key_prefix: string;
          last_used_at: string | null;
          name: string;
          owner_id: string;
          revoked_at: string | null;
        };
        Insert: {
          created_at?: string;
          id?: string;
          key_hash: string;
          key_prefix: string;
          last_used_at?: string | null;
          name: string;
          owner_id: string;
          revoked_at?: string | null;
        };
        Update: {
          created_at?: string;
          id?: string;
          key_hash?: string;
          key_prefix?: string;
          last_used_at?: string | null;
          name?: string;
          owner_id?: string;
          revoked_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "api_keys_owner_id_fkey";
            columns: ["owner_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      api_rate_limits: {
        Row: {
          api_key_id: string;
          request_count: number;
          window_start: string;
        };
        Insert: {
          api_key_id: string;
          request_count?: number;
          window_start: string;
        };
        Update: {
          api_key_id?: string;
          request_count?: number;
          window_start?: string;
        };
        Relationships: [
          {
            foreignKeyName: "api_rate_limits_api_key_id_fkey";
            columns: ["api_key_id"];
            isOneToOne: false;
            referencedRelation: "api_keys";
            referencedColumns: ["id"];
          },
        ];
      };
      app_settings: {
        Row: {
          calendly_access_token: string | null;
          calendly_connected_at: string | null;
          calendly_last_sync_at: string | null;
          calendly_organization_uri: string | null;
          calendly_refresh_token: string | null;
          calendly_user_uri: string | null;
          close_api_key: string | null;
          close_connected_at: string | null;
          dialer_tick_secret: string | null;
          elevenlabs_init_webhook_secret: string | null;
          elevenlabs_post_call_webhook_id: string | null;
          elevenlabs_post_call_webhook_secret: string | null;
          elevenlabs_tool_webhook_secret: string | null;
          elevenlabs_voice_ids: string | null;
          id: number;
          meta_access_token: string | null;
          meta_ad_account_id: string | null;
          meta_audience_terms_accepted_at: string | null;
          meta_connected_at: string | null;
          meta_custom_audience_id: string | null;
          meta_last_sync_at: string | null;
          meta_last_sync_count: number;
          meta_last_sync_error: string | null;
          meta_sync_secret: string | null;
          updated_at: string;
        };
        Insert: {
          calendly_access_token?: string | null;
          calendly_connected_at?: string | null;
          calendly_last_sync_at?: string | null;
          calendly_organization_uri?: string | null;
          calendly_refresh_token?: string | null;
          calendly_user_uri?: string | null;
          close_api_key?: string | null;
          close_connected_at?: string | null;
          dialer_tick_secret?: string | null;
          elevenlabs_init_webhook_secret?: string | null;
          elevenlabs_post_call_webhook_id?: string | null;
          elevenlabs_post_call_webhook_secret?: string | null;
          elevenlabs_tool_webhook_secret?: string | null;
          elevenlabs_voice_ids?: string | null;
          id?: number;
          meta_access_token?: string | null;
          meta_ad_account_id?: string | null;
          meta_audience_terms_accepted_at?: string | null;
          meta_connected_at?: string | null;
          meta_custom_audience_id?: string | null;
          meta_last_sync_at?: string | null;
          meta_last_sync_count?: number;
          meta_last_sync_error?: string | null;
          meta_sync_secret?: string | null;
          updated_at?: string;
        };
        Update: {
          calendly_access_token?: string | null;
          calendly_connected_at?: string | null;
          calendly_last_sync_at?: string | null;
          calendly_organization_uri?: string | null;
          calendly_refresh_token?: string | null;
          calendly_user_uri?: string | null;
          close_api_key?: string | null;
          close_connected_at?: string | null;
          dialer_tick_secret?: string | null;
          elevenlabs_init_webhook_secret?: string | null;
          elevenlabs_post_call_webhook_id?: string | null;
          elevenlabs_post_call_webhook_secret?: string | null;
          elevenlabs_tool_webhook_secret?: string | null;
          elevenlabs_voice_ids?: string | null;
          id?: number;
          meta_access_token?: string | null;
          meta_ad_account_id?: string | null;
          meta_audience_terms_accepted_at?: string | null;
          meta_connected_at?: string | null;
          meta_custom_audience_id?: string | null;
          meta_last_sync_at?: string | null;
          meta_last_sync_count?: number;
          meta_last_sync_error?: string | null;
          meta_sync_secret?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      calendly_event_types: {
        Row: {
          active: boolean;
          duration_minutes: number | null;
          event_uri: string;
          id: string;
          name: string;
          owner_id: string | null;
          scheduling_url: string | null;
          synced_at: string;
        };
        Insert: {
          active?: boolean;
          duration_minutes?: number | null;
          event_uri: string;
          id?: string;
          name: string;
          owner_id?: string | null;
          scheduling_url?: string | null;
          synced_at?: string;
        };
        Update: {
          active?: boolean;
          duration_minutes?: number | null;
          event_uri?: string;
          id?: string;
          name?: string;
          owner_id?: string | null;
          scheduling_url?: string | null;
          synced_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "calendly_event_types_owner_id_fkey";
            columns: ["owner_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      calendly_events: {
        Row: {
          cancel_url: string | null;
          created_at: string;
          event_type_uri: string | null;
          event_uri: string;
          id: string;
          invitee_email: string | null;
          invitee_name: string | null;
          invitee_phone: string | null;
          invitee_uri: string;
          lead_id: string | null;
          owner_id: string;
          raw: Json | null;
          reschedule_url: string | null;
          scheduled_at: string | null;
          status: string;
          updated_at: string;
        };
        Insert: {
          cancel_url?: string | null;
          created_at?: string;
          event_type_uri?: string | null;
          event_uri: string;
          id?: string;
          invitee_email?: string | null;
          invitee_name?: string | null;
          invitee_phone?: string | null;
          invitee_uri: string;
          lead_id?: string | null;
          owner_id: string;
          raw?: Json | null;
          reschedule_url?: string | null;
          scheduled_at?: string | null;
          status?: string;
          updated_at?: string;
        };
        Update: {
          cancel_url?: string | null;
          created_at?: string;
          event_type_uri?: string | null;
          event_uri?: string;
          id?: string;
          invitee_email?: string | null;
          invitee_name?: string | null;
          invitee_phone?: string | null;
          invitee_uri?: string;
          lead_id?: string | null;
          owner_id?: string;
          raw?: Json | null;
          reschedule_url?: string | null;
          scheduled_at?: string | null;
          status?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "calendly_events_lead_id_fkey";
            columns: ["lead_id"];
            isOneToOne: false;
            referencedRelation: "dial_queue";
            referencedColumns: ["lead_id"];
          },
          {
            foreignKeyName: "calendly_events_lead_id_fkey";
            columns: ["lead_id"];
            isOneToOne: false;
            referencedRelation: "leads";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "calendly_events_owner_id_fkey";
            columns: ["owner_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
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
          voicemail_attempts: number;
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
          voicemail_attempts?: number;
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
          voicemail_attempts?: number;
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
          autopilot_enabled: boolean;
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
          autopilot_enabled?: boolean;
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
          autopilot_enabled?: boolean;
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
          event_type: string;
          raw_payload: Json | null;
          received_at: string;
        };
        Insert: {
          conversation_id: string;
          event_type?: string;
          raw_payload?: Json | null;
          received_at?: string;
        };
        Update: {
          conversation_id?: string;
          event_type?: string;
          raw_payload?: Json | null;
          received_at?: string;
        };
        Relationships: [];
      };
      email_templates: {
        Row: {
          body: string;
          created_at: string;
          id: string;
          last_used_at: string | null;
          name: string;
          owner_id: string;
          subject: string;
          updated_at: string;
        };
        Insert: {
          body: string;
          created_at?: string;
          id?: string;
          last_used_at?: string | null;
          name: string;
          owner_id: string;
          subject: string;
          updated_at?: string;
        };
        Update: {
          body?: string;
          created_at?: string;
          id?: string;
          last_used_at?: string | null;
          name?: string;
          owner_id?: string;
          subject?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "email_templates_owner_id_fkey";
            columns: ["owner_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      emails: {
        Row: {
          body: string | null;
          call_id: string | null;
          campaign_id: string | null;
          close_message_id: string | null;
          created_at: string;
          direction: string;
          from_address: string | null;
          id: string;
          lead_id: string;
          owner_id: string;
          raw: Json | null;
          status: string;
          subject: string | null;
          template_id: string | null;
          to_address: string | null;
          updated_at: string;
        };
        Insert: {
          body?: string | null;
          call_id?: string | null;
          campaign_id?: string | null;
          close_message_id?: string | null;
          created_at?: string;
          direction: string;
          from_address?: string | null;
          id?: string;
          lead_id: string;
          owner_id: string;
          raw?: Json | null;
          status?: string;
          subject?: string | null;
          template_id?: string | null;
          to_address?: string | null;
          updated_at?: string;
        };
        Update: {
          body?: string | null;
          call_id?: string | null;
          campaign_id?: string | null;
          close_message_id?: string | null;
          created_at?: string;
          direction?: string;
          from_address?: string | null;
          id?: string;
          lead_id?: string;
          owner_id?: string;
          raw?: Json | null;
          status?: string;
          subject?: string | null;
          template_id?: string | null;
          to_address?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "emails_call_id_fkey";
            columns: ["call_id"];
            isOneToOne: false;
            referencedRelation: "calls";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "emails_campaign_id_fkey";
            columns: ["campaign_id"];
            isOneToOne: false;
            referencedRelation: "campaigns";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "emails_campaign_id_fkey";
            columns: ["campaign_id"];
            isOneToOne: false;
            referencedRelation: "dial_queue";
            referencedColumns: ["campaign_id"];
          },
          {
            foreignKeyName: "emails_lead_id_fkey";
            columns: ["lead_id"];
            isOneToOne: false;
            referencedRelation: "dial_queue";
            referencedColumns: ["lead_id"];
          },
          {
            foreignKeyName: "emails_lead_id_fkey";
            columns: ["lead_id"];
            isOneToOne: false;
            referencedRelation: "leads";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "emails_owner_id_fkey";
            columns: ["owner_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "emails_template_id_fkey";
            columns: ["template_id"];
            isOneToOne: false;
            referencedRelation: "email_templates";
            referencedColumns: ["id"];
          },
        ];
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
          calendly_event_uri: string | null;
          call_attempts: number;
          category: string | null;
          city: string | null;
          company: string | null;
          conversations: number;
          created_at: string;
          decision_maker_reached: boolean;
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
          meta_synced_at: string | null;
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
          calendly_event_uri?: string | null;
          call_attempts?: number;
          category?: string | null;
          city?: string | null;
          company?: string | null;
          conversations?: number;
          created_at?: string;
          decision_maker_reached?: boolean;
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
          meta_synced_at?: string | null;
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
          calendly_event_uri?: string | null;
          call_attempts?: number;
          category?: string | null;
          city?: string | null;
          company?: string | null;
          conversations?: number;
          created_at?: string;
          decision_maker_reached?: boolean;
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
          meta_synced_at?: string | null;
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
      lookup_charges: {
        Row: {
          cost: number;
          created_at: string;
          id: string;
          lookups: number;
          owner_id: string;
          source: string;
        };
        Insert: {
          cost: number;
          created_at?: string;
          id?: string;
          lookups: number;
          owner_id: string;
          source?: string;
        };
        Update: {
          cost?: number;
          created_at?: string;
          id?: string;
          lookups?: number;
          owner_id?: string;
          source?: string;
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
          active_campaign_id: string | null;
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
          active_campaign_id?: string | null;
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
          active_campaign_id?: string | null;
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
        Relationships: [
          {
            foreignKeyName: "profiles_active_campaign_id_fkey";
            columns: ["active_campaign_id"];
            isOneToOne: false;
            referencedRelation: "campaigns";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "profiles_active_campaign_id_fkey";
            columns: ["active_campaign_id"];
            isOneToOne: false;
            referencedRelation: "dial_queue";
            referencedColumns: ["campaign_id"];
          },
        ];
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
          elevenlabs_phone_number_id: string | null;
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
          status_webhook_url: string | null;
          twilio_sid: string | null;
          voice_webhook_url: string | null;
        };
        Insert: {
          attached_campaign_id?: string | null;
          country: string;
          elevenlabs_phone_number_id?: string | null;
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
          status_webhook_url?: string | null;
          twilio_sid?: string | null;
          voice_webhook_url?: string | null;
        };
        Update: {
          attached_campaign_id?: string | null;
          country?: string;
          elevenlabs_phone_number_id?: string | null;
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
          status_webhook_url?: string | null;
          twilio_sid?: string | null;
          voice_webhook_url?: string | null;
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
      user_integrations: {
        Row: {
          calendly_api_key: string | null;
          calendly_connected_at: string | null;
          calendly_last_sync_at: string | null;
          calendly_organization_uri: string | null;
          calendly_user_uri: string | null;
          close_api_key: string | null;
          close_connected_at: string | null;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          calendly_api_key?: string | null;
          calendly_connected_at?: string | null;
          calendly_last_sync_at?: string | null;
          calendly_organization_uri?: string | null;
          calendly_user_uri?: string | null;
          close_api_key?: string | null;
          close_connected_at?: string | null;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          calendly_api_key?: string | null;
          calendly_connected_at?: string | null;
          calendly_last_sync_at?: string | null;
          calendly_organization_uri?: string | null;
          calendly_user_uri?: string | null;
          close_api_key?: string | null;
          close_connected_at?: string | null;
          updated_at?: string;
          user_id?: string;
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
      bump_api_rate_limit: {
        Args: { in_api_key_id: string; in_window_seconds: number };
        Returns: number;
      };
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
      merge_inbound_lead: {
        Args: {
          in_actor: string;
          in_destination_lead_id: string;
          in_patch: Json;
          in_source_lead_id: string;
        };
        Returns: undefined;
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
