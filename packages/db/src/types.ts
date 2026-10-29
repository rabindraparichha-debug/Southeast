export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  public: {
    Tables: {
      addresses: {
        Row: {
          area: string | null;
          created_at: string;
          customer_id: string;
          delivery_notes: string | null;
          geo_point: unknown;
          id: string;
          is_default: boolean;
          kitchen_id: string;
          label: string | null;
          landmark: string | null;
          lat: number | null;
          line1: string | null;
          lng: number | null;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          area?: string | null;
          created_at?: string;
          customer_id: string;
          delivery_notes?: string | null;
          geo_point?: never;
          id?: string;
          is_default?: boolean;
          kitchen_id: string;
          label?: string | null;
          landmark?: string | null;
          lat?: number | null;
          line1?: string | null;
          lng?: number | null;
          updated_at?: string;
        };
        Update: {
          area?: string | null;
          created_at?: string;
          customer_id?: string;
          delivery_notes?: string | null;
          geo_point?: never;
          id?: string;
          is_default?: boolean;
          kitchen_id?: string;
          label?: string | null;
          landmark?: string | null;
          lat?: number | null;
          line1?: string | null;
          lng?: number | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'addresses_customer_id_kitchen_id_fkey';
            columns: ['customer_id', 'kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'customers';
            referencedColumns: ['id', 'kitchen_id'];
          },
          {
            foreignKeyName: 'addresses_customer_id_kitchen_id_fkey';
            columns: ['customer_id', 'kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'customers_v';
            referencedColumns: ['id', 'kitchen_id'];
          },
        ];
      };
      areas: {
        Row: {
          aliases: string[];
          city: string;
          id: string;
          lat: number;
          lng: number;
          name: string;
        };
        ComputedFields: never;
        Insert: {
          aliases?: string[];
          city?: string;
          id?: string;
          lat: number;
          lng: number;
          name: string;
        };
        Update: {
          aliases?: string[];
          city?: string;
          id?: string;
          lat?: number;
          lng?: number;
          name?: string;
        };
        Relationships: [];
      };
      audit_log: {
        Row: {
          action: string;
          actor_id: string | null;
          actor_role: string | null;
          after: Json | null;
          before: Json | null;
          created_at: string;
          id: number;
          kitchen_id: string | null;
          row_id: string | null;
          table_name: string;
        };
        ComputedFields: never;
        Insert: {
          action: string;
          actor_id?: string | null;
          actor_role?: string | null;
          after?: Json | null;
          before?: Json | null;
          created_at?: string;
          id?: never;
          kitchen_id?: string | null;
          row_id?: string | null;
          table_name: string;
        };
        Update: {
          action?: string;
          actor_id?: string | null;
          actor_role?: string | null;
          after?: Json | null;
          before?: Json | null;
          created_at?: string;
          id?: never;
          kitchen_id?: string | null;
          row_id?: string | null;
          table_name?: string;
        };
        Relationships: [];
      };
      balance_entries: {
        Row: {
          amount_paise: number;
          created_at: string;
          created_by: string | null;
          customer_id: string;
          id: string;
          kitchen_id: string;
          meals: number;
          note: string | null;
          ref_id: string | null;
          ref_type: string | null;
          seq: number;
          type: Database['public']['Enums']['balance_entry_type'];
        };
        ComputedFields: never;
        Insert: {
          amount_paise?: number;
          created_at?: string;
          created_by?: string | null;
          customer_id: string;
          id?: string;
          kitchen_id: string;
          meals: number;
          note?: string | null;
          ref_id?: string | null;
          ref_type?: string | null;
          seq?: never;
          type: Database['public']['Enums']['balance_entry_type'];
        };
        Update: {
          amount_paise?: number;
          created_at?: string;
          created_by?: string | null;
          customer_id?: string;
          id?: string;
          kitchen_id?: string;
          meals?: number;
          note?: string | null;
          ref_id?: string | null;
          ref_type?: string | null;
          seq?: never;
          type?: Database['public']['Enums']['balance_entry_type'];
        };
        Relationships: [
          {
            foreignKeyName: 'balance_entries_customer_id_kitchen_id_fkey';
            columns: ['customer_id', 'kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'customers';
            referencedColumns: ['id', 'kitchen_id'];
          },
          {
            foreignKeyName: 'balance_entries_customer_id_kitchen_id_fkey';
            columns: ['customer_id', 'kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'customers_v';
            referencedColumns: ['id', 'kitchen_id'];
          },
        ];
      };
      broadcasts: {
        Row: {
          body: string;
          created_at: string;
          created_by: string | null;
          id: string;
          kitchen_id: string;
          recipients: number;
        };
        ComputedFields: never;
        Insert: {
          body: string;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          kitchen_id: string;
          recipients: number;
        };
        Update: {
          body?: string;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          kitchen_id?: string;
          recipients?: number;
        };
        Relationships: [
          {
            foreignKeyName: 'broadcasts_kitchen_id_fkey';
            columns: ['kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'kitchens';
            referencedColumns: ['id'];
          },
        ];
      };
      complaints: {
        Row: {
          category: string;
          channel: string;
          conversation_id: string | null;
          created_at: string;
          customer_id: string;
          description: string | null;
          escalated_at: string | null;
          id: string;
          kitchen_id: string;
          meal_order_id: string | null;
          photo_url: string | null;
          refund_entry_id: string | null;
          resolution_note: string | null;
          resolved_at: string | null;
          responded_at: string | null;
          status: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          category: string;
          channel: string;
          conversation_id?: string | null;
          created_at?: string;
          customer_id: string;
          description?: string | null;
          escalated_at?: string | null;
          id?: string;
          kitchen_id: string;
          meal_order_id?: string | null;
          photo_url?: string | null;
          refund_entry_id?: string | null;
          resolution_note?: string | null;
          resolved_at?: string | null;
          responded_at?: string | null;
          status?: string;
          updated_at?: string;
        };
        Update: {
          category?: string;
          channel?: string;
          conversation_id?: string | null;
          created_at?: string;
          customer_id?: string;
          description?: string | null;
          escalated_at?: string | null;
          id?: string;
          kitchen_id?: string;
          meal_order_id?: string | null;
          photo_url?: string | null;
          refund_entry_id?: string | null;
          resolution_note?: string | null;
          resolved_at?: string | null;
          responded_at?: string | null;
          status?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'complaints_conversation_id_fkey';
            columns: ['conversation_id'];
            isOneToOne: false;
            referencedRelation: 'conversations';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'complaints_customer_id_kitchen_id_fkey';
            columns: ['customer_id', 'kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'customers';
            referencedColumns: ['id', 'kitchen_id'];
          },
          {
            foreignKeyName: 'complaints_customer_id_kitchen_id_fkey';
            columns: ['customer_id', 'kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'customers_v';
            referencedColumns: ['id', 'kitchen_id'];
          },
          {
            foreignKeyName: 'complaints_meal_order_id_kitchen_id_fkey';
            columns: ['meal_order_id', 'kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'meal_orders';
            referencedColumns: ['id', 'kitchen_id'];
          },
          {
            foreignKeyName: 'complaints_refund_entry_id_fkey';
            columns: ['refund_entry_id'];
            isOneToOne: false;
            referencedRelation: 'balance_entries';
            referencedColumns: ['id'];
          },
        ];
      };
      consents: {
        Row: {
          basis: string;
          channel: string;
          created_at: string;
          customer_id: string;
          id: string;
          kitchen_id: string;
          notice_version: string;
          purpose: string;
          recorded_by: string | null;
          withdrawn_at: string | null;
        };
        ComputedFields: never;
        Insert: {
          basis: string;
          channel: string;
          created_at?: string;
          customer_id: string;
          id?: string;
          kitchen_id: string;
          notice_version?: string;
          purpose: string;
          recorded_by?: string | null;
          withdrawn_at?: string | null;
        };
        Update: {
          basis?: string;
          channel?: string;
          created_at?: string;
          customer_id?: string;
          id?: string;
          kitchen_id?: string;
          notice_version?: string;
          purpose?: string;
          recorded_by?: string | null;
          withdrawn_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'consents_customer_id_kitchen_id_fkey';
            columns: ['customer_id', 'kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'customers';
            referencedColumns: ['id', 'kitchen_id'];
          },
          {
            foreignKeyName: 'consents_customer_id_kitchen_id_fkey';
            columns: ['customer_id', 'kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'customers_v';
            referencedColumns: ['id', 'kitchen_id'];
          },
        ];
      };
      conversations: {
        Row: {
          contact_name: string | null;
          created_at: string;
          customer_id: string | null;
          handoff_at: string | null;
          handoff_open: boolean;
          id: string;
          kitchen_id: string | null;
          language: Database['public']['Enums']['language_code'];
          last_inbound_at: string | null;
          last_message_at: string | null;
          phone_enc: string;
          phone_last4: string;
          state: NonNullable<Json>;
          unread_count: number;
          updated_at: string;
          wa_phone_hash: string;
        };
        ComputedFields: never;
        Insert: {
          contact_name?: string | null;
          created_at?: string;
          customer_id?: string | null;
          handoff_at?: string | null;
          handoff_open?: boolean;
          id?: string;
          kitchen_id?: string | null;
          language?: Database['public']['Enums']['language_code'];
          last_inbound_at?: string | null;
          last_message_at?: string | null;
          phone_enc: string;
          phone_last4: string;
          state?: NonNullable<Json>;
          unread_count?: number;
          updated_at?: string;
          wa_phone_hash: string;
        };
        Update: {
          contact_name?: string | null;
          created_at?: string;
          customer_id?: string | null;
          handoff_at?: string | null;
          handoff_open?: boolean;
          id?: string;
          kitchen_id?: string | null;
          language?: Database['public']['Enums']['language_code'];
          last_inbound_at?: string | null;
          last_message_at?: string | null;
          phone_enc?: string;
          phone_last4?: string;
          state?: NonNullable<Json>;
          unread_count?: number;
          updated_at?: string;
          wa_phone_hash?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'conversations_customer_id_kitchen_id_fkey';
            columns: ['customer_id', 'kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'customers';
            referencedColumns: ['id', 'kitchen_id'];
          },
          {
            foreignKeyName: 'conversations_customer_id_kitchen_id_fkey';
            columns: ['customer_id', 'kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'customers_v';
            referencedColumns: ['id', 'kitchen_id'];
          },
          {
            foreignKeyName: 'conversations_kitchen_id_fkey';
            columns: ['kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'kitchens';
            referencedColumns: ['id'];
          },
        ];
      };
      count_snapshots: {
        Row: {
          id: string;
          kitchen_id: string;
          locked_at: string;
          service_date: string;
          slot: Database['public']['Enums']['meal_slot'];
          totals: NonNullable<Json>;
        };
        ComputedFields: never;
        Insert: {
          id?: string;
          kitchen_id: string;
          locked_at: string;
          service_date: string;
          slot: Database['public']['Enums']['meal_slot'];
          totals: NonNullable<Json>;
        };
        Update: {
          id?: string;
          kitchen_id?: string;
          locked_at?: string;
          service_date?: string;
          slot?: Database['public']['Enums']['meal_slot'];
          totals?: NonNullable<Json>;
        };
        Relationships: [
          {
            foreignKeyName: 'count_snapshots_kitchen_id_fkey';
            columns: ['kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'kitchens';
            referencedColumns: ['id'];
          },
        ];
      };
      customer_magic_links: {
        Row: {
          created_at: string;
          customer_id: string;
          expires_at: string;
          id: string;
          kitchen_id: string;
          last_used_at: string | null;
          revoked_at: string | null;
          token_hash: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          customer_id: string;
          expires_at: string;
          id?: string;
          kitchen_id: string;
          last_used_at?: string | null;
          revoked_at?: string | null;
          token_hash: string;
        };
        Update: {
          created_at?: string;
          customer_id?: string;
          expires_at?: string;
          id?: string;
          kitchen_id?: string;
          last_used_at?: string | null;
          revoked_at?: string | null;
          token_hash?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'customer_magic_links_customer_id_kitchen_id_fkey';
            columns: ['customer_id', 'kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'customers';
            referencedColumns: ['id', 'kitchen_id'];
          },
          {
            foreignKeyName: 'customer_magic_links_customer_id_kitchen_id_fkey';
            columns: ['customer_id', 'kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'customers_v';
            referencedColumns: ['id', 'kitchen_id'];
          },
        ];
      };
      customers: {
        Row: {
          consent_at: string | null;
          consent_basis: string | null;
          created_at: string;
          created_by: string | null;
          deleted_at: string | null;
          diet: Database['public']['Enums']['diet_type'];
          id: string;
          kitchen_id: string;
          name: string;
          notes: string | null;
          payer_customer_id: string | null;
          phone_enc: string | null;
          phone_hash: string | null;
          phone_last4: string | null;
          platform_sourced: boolean;
          preferred_language: Database['public']['Enums']['language_code'];
          source: Database['public']['Enums']['customer_source'];
          updated_at: string;
          whatsapp_opt_in: boolean;
        };
        ComputedFields: never;
        Insert: {
          consent_at?: string | null;
          consent_basis?: string | null;
          created_at?: string;
          created_by?: string | null;
          deleted_at?: string | null;
          diet?: Database['public']['Enums']['diet_type'];
          id?: string;
          kitchen_id: string;
          name: string;
          notes?: string | null;
          payer_customer_id?: string | null;
          phone_enc?: string | null;
          phone_hash?: string | null;
          phone_last4?: string | null;
          platform_sourced?: boolean;
          preferred_language?: Database['public']['Enums']['language_code'];
          source?: Database['public']['Enums']['customer_source'];
          updated_at?: string;
          whatsapp_opt_in?: boolean;
        };
        Update: {
          consent_at?: string | null;
          consent_basis?: string | null;
          created_at?: string;
          created_by?: string | null;
          deleted_at?: string | null;
          diet?: Database['public']['Enums']['diet_type'];
          id?: string;
          kitchen_id?: string;
          name?: string;
          notes?: string | null;
          payer_customer_id?: string | null;
          phone_enc?: string | null;
          phone_hash?: string | null;
          phone_last4?: string | null;
          platform_sourced?: boolean;
          preferred_language?: Database['public']['Enums']['language_code'];
          source?: Database['public']['Enums']['customer_source'];
          updated_at?: string;
          whatsapp_opt_in?: boolean;
        };
        Relationships: [
          {
            foreignKeyName: 'customers_kitchen_id_fkey';
            columns: ['kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'kitchens';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'customers_payer_customer_id_kitchen_id_fkey';
            columns: ['payer_customer_id', 'kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'customers';
            referencedColumns: ['id', 'kitchen_id'];
          },
          {
            foreignKeyName: 'customers_payer_customer_id_kitchen_id_fkey';
            columns: ['payer_customer_id', 'kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'customers_v';
            referencedColumns: ['id', 'kitchen_id'];
          },
        ];
      };
      delivery_routes: {
        Row: {
          active: boolean;
          created_at: string;
          id: string;
          kitchen_id: string;
          name: string;
          rider_id: string | null;
          slot: Database['public']['Enums']['meal_slot'];
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          active?: boolean;
          created_at?: string;
          id?: string;
          kitchen_id: string;
          name: string;
          rider_id?: string | null;
          slot: Database['public']['Enums']['meal_slot'];
          updated_at?: string;
        };
        Update: {
          active?: boolean;
          created_at?: string;
          id?: string;
          kitchen_id?: string;
          name?: string;
          rider_id?: string | null;
          slot?: Database['public']['Enums']['meal_slot'];
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'delivery_routes_kitchen_id_fkey';
            columns: ['kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'kitchens';
            referencedColumns: ['id'];
          },
        ];
      };
      delivery_runs: {
        Row: {
          created_at: string;
          finished_at: string | null;
          id: string;
          kitchen_id: string;
          last_lat: number | null;
          last_lng: number | null;
          last_seen_at: string | null;
          planned_km: number | null;
          rider_id: string | null;
          route_id: string;
          service_date: string;
          slot: Database['public']['Enums']['meal_slot'];
          started_at: string | null;
          status: Database['public']['Enums']['run_status'];
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          finished_at?: string | null;
          id?: string;
          kitchen_id: string;
          last_lat?: number | null;
          last_lng?: number | null;
          last_seen_at?: string | null;
          planned_km?: number | null;
          rider_id?: string | null;
          route_id: string;
          service_date: string;
          slot: Database['public']['Enums']['meal_slot'];
          started_at?: string | null;
          status?: Database['public']['Enums']['run_status'];
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          finished_at?: string | null;
          id?: string;
          kitchen_id?: string;
          last_lat?: number | null;
          last_lng?: number | null;
          last_seen_at?: string | null;
          planned_km?: number | null;
          rider_id?: string | null;
          route_id?: string;
          service_date?: string;
          slot?: Database['public']['Enums']['meal_slot'];
          started_at?: string | null;
          status?: Database['public']['Enums']['run_status'];
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'delivery_runs_kitchen_id_fkey';
            columns: ['kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'kitchens';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'delivery_runs_route_id_kitchen_id_slot_fkey';
            columns: ['route_id', 'kitchen_id', 'slot'];
            isOneToOne: false;
            referencedRelation: 'delivery_routes';
            referencedColumns: ['id', 'kitchen_id', 'slot'];
          },
        ];
      };
      delivery_stops: {
        Row: {
          address_id: string | null;
          cash_payment_id: string | null;
          client_op_id: string | null;
          created_at: string;
          credit_entry_id: string | null;
          customer_id: string;
          device_at: string | null;
          done_at: string | null;
          done_by: string | null;
          failed_note: string | null;
          failed_reason: Database['public']['Enums']['fail_reason'] | null;
          gps_accuracy_m: number | null;
          gps_distance_m: number | null;
          gps_lat: number | null;
          gps_lng: number | null;
          id: string;
          kitchen_fault: boolean | null;
          kitchen_id: string;
          meal_count: number;
          offline: boolean;
          otp: string | null;
          otp_attempts: number;
          otp_ok: boolean | null;
          photo_path: string | null;
          proof_type: Database['public']['Enums']['proof_type'] | null;
          run_id: string;
          seq: number;
          status: Database['public']['Enums']['stop_status'];
          synced_at: string | null;
          tiffins_out: number;
          tiffins_returned: number;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          address_id?: string | null;
          cash_payment_id?: string | null;
          client_op_id?: string | null;
          created_at?: string;
          credit_entry_id?: string | null;
          customer_id: string;
          device_at?: string | null;
          done_at?: string | null;
          done_by?: string | null;
          failed_note?: string | null;
          failed_reason?: Database['public']['Enums']['fail_reason'] | null;
          gps_accuracy_m?: number | null;
          gps_distance_m?: number | null;
          gps_lat?: number | null;
          gps_lng?: number | null;
          id?: string;
          kitchen_fault?: boolean | null;
          kitchen_id: string;
          meal_count: number;
          offline?: boolean;
          otp?: string | null;
          otp_attempts?: number;
          otp_ok?: boolean | null;
          photo_path?: string | null;
          proof_type?: Database['public']['Enums']['proof_type'] | null;
          run_id: string;
          seq: number;
          status?: Database['public']['Enums']['stop_status'];
          synced_at?: string | null;
          tiffins_out?: number;
          tiffins_returned?: number;
          updated_at?: string;
        };
        Update: {
          address_id?: string | null;
          cash_payment_id?: string | null;
          client_op_id?: string | null;
          created_at?: string;
          credit_entry_id?: string | null;
          customer_id?: string;
          device_at?: string | null;
          done_at?: string | null;
          done_by?: string | null;
          failed_note?: string | null;
          failed_reason?: Database['public']['Enums']['fail_reason'] | null;
          gps_accuracy_m?: number | null;
          gps_distance_m?: number | null;
          gps_lat?: number | null;
          gps_lng?: number | null;
          id?: string;
          kitchen_fault?: boolean | null;
          kitchen_id?: string;
          meal_count?: number;
          offline?: boolean;
          otp?: string | null;
          otp_attempts?: number;
          otp_ok?: boolean | null;
          photo_path?: string | null;
          proof_type?: Database['public']['Enums']['proof_type'] | null;
          run_id?: string;
          seq?: number;
          status?: Database['public']['Enums']['stop_status'];
          synced_at?: string | null;
          tiffins_out?: number;
          tiffins_returned?: number;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'delivery_stops_address_id_kitchen_id_fkey';
            columns: ['address_id', 'kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'addresses';
            referencedColumns: ['id', 'kitchen_id'];
          },
          {
            foreignKeyName: 'delivery_stops_customer_id_kitchen_id_fkey';
            columns: ['customer_id', 'kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'customers';
            referencedColumns: ['id', 'kitchen_id'];
          },
          {
            foreignKeyName: 'delivery_stops_customer_id_kitchen_id_fkey';
            columns: ['customer_id', 'kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'customers_v';
            referencedColumns: ['id', 'kitchen_id'];
          },
          {
            foreignKeyName: 'delivery_stops_run_id_kitchen_id_fkey';
            columns: ['run_id', 'kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'delivery_runs';
            referencedColumns: ['id', 'kitchen_id'];
          },
        ];
      };
      dishes: {
        Row: {
          active: boolean;
          created_at: string;
          id: string;
          kitchen_id: string;
          name: string;
          serves: Database['public']['Enums']['diet_type'][];
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          active?: boolean;
          created_at?: string;
          id?: string;
          kitchen_id: string;
          name: string;
          serves?: Database['public']['Enums']['diet_type'][];
          updated_at?: string;
        };
        Update: {
          active?: boolean;
          created_at?: string;
          id?: string;
          kitchen_id?: string;
          name?: string;
          serves?: Database['public']['Enums']['diet_type'][];
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'dishes_kitchen_id_fkey';
            columns: ['kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'kitchens';
            referencedColumns: ['id'];
          },
        ];
      };
      import_batches: {
        Row: {
          created_at: string;
          created_by: string | null;
          error_rows: number;
          file_name: string | null;
          id: string;
          imported_rows: number;
          kitchen_id: string;
          total_rows: number;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          created_by?: string | null;
          error_rows?: number;
          file_name?: string | null;
          id?: string;
          imported_rows?: number;
          kitchen_id: string;
          total_rows?: number;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          error_rows?: number;
          file_name?: string | null;
          id?: string;
          imported_rows?: number;
          kitchen_id?: string;
          total_rows?: number;
        };
        Relationships: [
          {
            foreignKeyName: 'import_batches_kitchen_id_fkey';
            columns: ['kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'kitchens';
            referencedColumns: ['id'];
          },
        ];
      };
      import_rows: {
        Row: {
          batch_id: string;
          customer_id: string | null;
          errors: string[];
          id: number;
          kitchen_id: string;
          raw: NonNullable<Json>;
          row_number: number;
          status: string;
        };
        ComputedFields: never;
        Insert: {
          batch_id: string;
          customer_id?: string | null;
          errors?: string[];
          id?: never;
          kitchen_id: string;
          raw: NonNullable<Json>;
          row_number: number;
          status: string;
        };
        Update: {
          batch_id?: string;
          customer_id?: string | null;
          errors?: string[];
          id?: never;
          kitchen_id?: string;
          raw?: NonNullable<Json>;
          row_number?: number;
          status?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'import_rows_batch_id_fkey';
            columns: ['batch_id'];
            isOneToOne: false;
            referencedRelation: 'import_batches';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'import_rows_kitchen_id_fkey';
            columns: ['kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'kitchens';
            referencedColumns: ['id'];
          },
        ];
      };
      items: {
        Row: {
          active: boolean;
          category: Database['public']['Enums']['item_category'];
          created_at: string;
          id: string;
          kitchen_id: string;
          last_price_paise: number | null;
          min_qty: number;
          name: string;
          unit: Database['public']['Enums']['stock_unit'];
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          active?: boolean;
          category?: Database['public']['Enums']['item_category'];
          created_at?: string;
          id?: string;
          kitchen_id: string;
          last_price_paise?: number | null;
          min_qty?: number;
          name: string;
          unit: Database['public']['Enums']['stock_unit'];
          updated_at?: string;
        };
        Update: {
          active?: boolean;
          category?: Database['public']['Enums']['item_category'];
          created_at?: string;
          id?: string;
          kitchen_id?: string;
          last_price_paise?: number | null;
          min_qty?: number;
          name?: string;
          unit?: Database['public']['Enums']['stock_unit'];
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'items_kitchen_id_fkey';
            columns: ['kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'kitchens';
            referencedColumns: ['id'];
          },
        ];
      };
      kitchen_payout_accounts: {
        Row: {
          created_at: string;
          kitchen_id: string;
          kyc_status: string;
          razorpay_linked_account_id: string | null;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          kitchen_id: string;
          kyc_status?: string;
          razorpay_linked_account_id?: string | null;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          kitchen_id?: string;
          kyc_status?: string;
          razorpay_linked_account_id?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'kitchen_payout_accounts_kitchen_id_fkey';
            columns: ['kitchen_id'];
            isOneToOne: true;
            referencedRelation: 'kitchens';
            referencedColumns: ['id'];
          },
        ];
      };
      kitchen_reviews: {
        Row: {
          comment: string | null;
          created_at: string;
          customer_id: string;
          hidden: boolean;
          id: string;
          kitchen_id: string;
          rating: number;
          updated_at: string;
          verified: boolean;
        };
        ComputedFields: never;
        Insert: {
          comment?: string | null;
          created_at?: string;
          customer_id: string;
          hidden?: boolean;
          id?: string;
          kitchen_id: string;
          rating: number;
          updated_at?: string;
          verified?: boolean;
        };
        Update: {
          comment?: string | null;
          created_at?: string;
          customer_id?: string;
          hidden?: boolean;
          id?: string;
          kitchen_id?: string;
          rating?: number;
          updated_at?: string;
          verified?: boolean;
        };
        Relationships: [
          {
            foreignKeyName: 'kitchen_reviews_customer_id_kitchen_id_fkey';
            columns: ['customer_id', 'kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'customers';
            referencedColumns: ['id', 'kitchen_id'];
          },
          {
            foreignKeyName: 'kitchen_reviews_customer_id_kitchen_id_fkey';
            columns: ['customer_id', 'kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'customers_v';
            referencedColumns: ['id', 'kitchen_id'];
          },
          {
            foreignKeyName: 'kitchen_reviews_kitchen_id_fkey';
            columns: ['kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'kitchens';
            referencedColumns: ['id'];
          },
        ];
      };
      kitchen_settings: {
        Row: {
          broadcast_cap_monthly: number;
          credit_limit_meals: number;
          gas_paise_per_meal: number;
          grace_days: number;
          kitchen_id: string;
          low_balance_meals: number;
          notice_days: number;
          packaging_paise_per_meal: number;
          phone_pause_close_time: string;
          price_jump_pct: number;
          updated_at: string;
          variance_reason_pct: number;
        };
        ComputedFields: never;
        Insert: {
          broadcast_cap_monthly?: number;
          credit_limit_meals?: number;
          gas_paise_per_meal?: number;
          grace_days?: number;
          kitchen_id: string;
          low_balance_meals?: number;
          notice_days?: number;
          packaging_paise_per_meal?: number;
          phone_pause_close_time?: string;
          price_jump_pct?: number;
          updated_at?: string;
          variance_reason_pct?: number;
        };
        Update: {
          broadcast_cap_monthly?: number;
          credit_limit_meals?: number;
          gas_paise_per_meal?: number;
          grace_days?: number;
          kitchen_id?: string;
          low_balance_meals?: number;
          notice_days?: number;
          packaging_paise_per_meal?: number;
          phone_pause_close_time?: string;
          price_jump_pct?: number;
          updated_at?: string;
          variance_reason_pct?: number;
        };
        Relationships: [
          {
            foreignKeyName: 'kitchen_settings_kitchen_id_fkey';
            columns: ['kitchen_id'];
            isOneToOne: true;
            referencedRelation: 'kitchens';
            referencedColumns: ['id'];
          },
        ];
      };
      kitchens: {
        Row: {
          accepts_platform_leads: boolean;
          address: string | null;
          area: string | null;
          capacity_dinner: number;
          capacity_lunch: number;
          city: string;
          created_at: string;
          cuisine_tags: string[];
          cutoff_dinner: string;
          cutoff_dinner_prev_day: boolean;
          cutoff_lunch: string;
          cutoff_lunch_prev_day: boolean;
          description: string | null;
          fssai_no: string | null;
          geo_point: unknown;
          id: string;
          lat: number | null;
          lng: number | null;
          name: string;
          owner_id: string;
          photo_paths: string[];
          service_radius_km: number;
          slug: string;
          status: Database['public']['Enums']['kitchen_status'];
          trial_meals: number;
          updated_at: string;
          weekly_off: number[];
        };
        ComputedFields: never;
        Insert: {
          accepts_platform_leads?: boolean;
          address?: string | null;
          area?: string | null;
          capacity_dinner?: number;
          capacity_lunch?: number;
          city?: string;
          created_at?: string;
          cuisine_tags?: string[];
          cutoff_dinner?: string;
          cutoff_dinner_prev_day?: boolean;
          cutoff_lunch?: string;
          cutoff_lunch_prev_day?: boolean;
          description?: string | null;
          fssai_no?: string | null;
          geo_point?: never;
          id?: string;
          lat?: number | null;
          lng?: number | null;
          name: string;
          owner_id: string;
          photo_paths?: string[];
          service_radius_km?: number;
          slug: string;
          status?: Database['public']['Enums']['kitchen_status'];
          trial_meals?: number;
          updated_at?: string;
          weekly_off?: number[];
        };
        Update: {
          accepts_platform_leads?: boolean;
          address?: string | null;
          area?: string | null;
          capacity_dinner?: number;
          capacity_lunch?: number;
          city?: string;
          created_at?: string;
          cuisine_tags?: string[];
          cutoff_dinner?: string;
          cutoff_dinner_prev_day?: boolean;
          cutoff_lunch?: string;
          cutoff_lunch_prev_day?: boolean;
          description?: string | null;
          fssai_no?: string | null;
          geo_point?: never;
          id?: string;
          lat?: number | null;
          lng?: number | null;
          name?: string;
          owner_id?: string;
          photo_paths?: string[];
          service_radius_km?: number;
          slug?: string;
          status?: Database['public']['Enums']['kitchen_status'];
          trial_meals?: number;
          updated_at?: string;
          weekly_off?: number[];
        };
        Relationships: [];
      };
      lead_events: {
        Row: {
          actor_id: string | null;
          created_at: string;
          detail: NonNullable<Json>;
          event: string;
          id: number;
          lead_id: string;
        };
        ComputedFields: never;
        Insert: {
          actor_id?: string | null;
          created_at?: string;
          detail?: NonNullable<Json>;
          event: string;
          id?: never;
          lead_id: string;
        };
        Update: {
          actor_id?: string | null;
          created_at?: string;
          detail?: NonNullable<Json>;
          event?: string;
          id?: never;
          lead_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'lead_events_lead_id_fkey';
            columns: ['lead_id'];
            isOneToOne: false;
            referencedRelation: 'leads';
            referencedColumns: ['id'];
          },
        ];
      };
      lead_matches: {
        Row: {
          created_at: string;
          distance_km: number;
          kitchen_id: string;
          lead_id: string;
          plan_id: string;
          price_per_meal_paise: number;
          rank: number;
          rating: number | null;
          reviews: number;
          score: number;
          spare: number;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          distance_km: number;
          kitchen_id: string;
          lead_id: string;
          plan_id: string;
          price_per_meal_paise: number;
          rank: number;
          rating?: number | null;
          reviews?: number;
          score: number;
          spare: number;
        };
        Update: {
          created_at?: string;
          distance_km?: number;
          kitchen_id?: string;
          lead_id?: string;
          plan_id?: string;
          price_per_meal_paise?: number;
          rank?: number;
          rating?: number | null;
          reviews?: number;
          score?: number;
          spare?: number;
        };
        Relationships: [
          {
            foreignKeyName: 'lead_matches_kitchen_id_fkey';
            columns: ['kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'kitchens';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'lead_matches_lead_id_fkey';
            columns: ['lead_id'];
            isOneToOne: false;
            referencedRelation: 'leads';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'lead_matches_plan_id_fkey';
            columns: ['plan_id'];
            isOneToOne: false;
            referencedRelation: 'plans';
            referencedColumns: ['id'];
          },
        ];
      };
      leads: {
        Row: {
          address_text: string | null;
          area: string | null;
          area_id: string | null;
          bot_step: string | null;
          budget_per_meal_paise: number | null;
          campaign: string | null;
          chosen_kitchen_id: string | null;
          consent_at: string | null;
          converted_at: string | null;
          created_at: string;
          customer_id: string | null;
          diet: Database['public']['Enums']['diet_type'] | null;
          external_id: string | null;
          followed_up_at: string | null;
          geo_point: unknown;
          id: string;
          language: Database['public']['Enums']['language_code'];
          lat: number | null;
          lng: number | null;
          lost_reason: string | null;
          matched_at: string | null;
          name: string | null;
          notes: string | null;
          phone_enc: string | null;
          phone_hash: string | null;
          phone_last4: string | null;
          qualified_at: string | null;
          reminded_at: string | null;
          renewed_at: string | null;
          slots: Database['public']['Enums']['meal_slot'][] | null;
          source: Database['public']['Enums']['lead_source'];
          start_date: string | null;
          status: Database['public']['Enums']['lead_status'];
          token_hash: string | null;
          trial_at: string | null;
          updated_at: string;
          whatsapp_opt_in: boolean;
        };
        ComputedFields: never;
        Insert: {
          address_text?: string | null;
          area?: string | null;
          area_id?: string | null;
          bot_step?: string | null;
          budget_per_meal_paise?: number | null;
          campaign?: string | null;
          chosen_kitchen_id?: string | null;
          consent_at?: string | null;
          converted_at?: string | null;
          created_at?: string;
          customer_id?: string | null;
          diet?: Database['public']['Enums']['diet_type'] | null;
          external_id?: string | null;
          followed_up_at?: string | null;
          geo_point?: never;
          id?: string;
          language?: Database['public']['Enums']['language_code'];
          lat?: number | null;
          lng?: number | null;
          lost_reason?: string | null;
          matched_at?: string | null;
          name?: string | null;
          notes?: string | null;
          phone_enc?: string | null;
          phone_hash?: string | null;
          phone_last4?: string | null;
          qualified_at?: string | null;
          reminded_at?: string | null;
          renewed_at?: string | null;
          slots?: Database['public']['Enums']['meal_slot'][] | null;
          source: Database['public']['Enums']['lead_source'];
          start_date?: string | null;
          status?: Database['public']['Enums']['lead_status'];
          token_hash?: string | null;
          trial_at?: string | null;
          updated_at?: string;
          whatsapp_opt_in?: boolean;
        };
        Update: {
          address_text?: string | null;
          area?: string | null;
          area_id?: string | null;
          bot_step?: string | null;
          budget_per_meal_paise?: number | null;
          campaign?: string | null;
          chosen_kitchen_id?: string | null;
          consent_at?: string | null;
          converted_at?: string | null;
          created_at?: string;
          customer_id?: string | null;
          diet?: Database['public']['Enums']['diet_type'] | null;
          external_id?: string | null;
          followed_up_at?: string | null;
          geo_point?: never;
          id?: string;
          language?: Database['public']['Enums']['language_code'];
          lat?: number | null;
          lng?: number | null;
          lost_reason?: string | null;
          matched_at?: string | null;
          name?: string | null;
          notes?: string | null;
          phone_enc?: string | null;
          phone_hash?: string | null;
          phone_last4?: string | null;
          qualified_at?: string | null;
          reminded_at?: string | null;
          renewed_at?: string | null;
          slots?: Database['public']['Enums']['meal_slot'][] | null;
          source?: Database['public']['Enums']['lead_source'];
          start_date?: string | null;
          status?: Database['public']['Enums']['lead_status'];
          token_hash?: string | null;
          trial_at?: string | null;
          updated_at?: string;
          whatsapp_opt_in?: boolean;
        };
        Relationships: [
          {
            foreignKeyName: 'leads_area_id_fkey';
            columns: ['area_id'];
            isOneToOne: false;
            referencedRelation: 'areas';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'leads_chosen_kitchen_id_fkey';
            columns: ['chosen_kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'kitchens';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'leads_customer_id_fkey';
            columns: ['customer_id'];
            isOneToOne: false;
            referencedRelation: 'customers';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'leads_customer_id_fkey';
            columns: ['customer_id'];
            isOneToOne: false;
            referencedRelation: 'customers_v';
            referencedColumns: ['id'];
          },
        ];
      };
      meal_orders: {
        Row: {
          address_id: string | null;
          change_id: string | null;
          charged: boolean;
          created_at: string;
          customer_id: string;
          diet: Database['public']['Enums']['diet_type'];
          id: string;
          kitchen_id: string;
          locked_at: string | null;
          plan_id: string;
          price_per_meal_paise: number | null;
          qty: number;
          run_id: string | null;
          service_date: string;
          skip_reason: string | null;
          slot: Database['public']['Enums']['meal_slot'];
          status: Database['public']['Enums']['order_status'];
          stop_id: string | null;
          stop_seq: number | null;
          subscription_id: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          address_id?: string | null;
          change_id?: string | null;
          charged?: boolean;
          created_at?: string;
          customer_id: string;
          diet: Database['public']['Enums']['diet_type'];
          id?: string;
          kitchen_id: string;
          locked_at?: string | null;
          plan_id: string;
          price_per_meal_paise?: number | null;
          qty: number;
          run_id?: string | null;
          service_date: string;
          skip_reason?: string | null;
          slot: Database['public']['Enums']['meal_slot'];
          status?: Database['public']['Enums']['order_status'];
          stop_id?: string | null;
          stop_seq?: number | null;
          subscription_id: string;
          updated_at?: string;
        };
        Update: {
          address_id?: string | null;
          change_id?: string | null;
          charged?: boolean;
          created_at?: string;
          customer_id?: string;
          diet?: Database['public']['Enums']['diet_type'];
          id?: string;
          kitchen_id?: string;
          locked_at?: string | null;
          plan_id?: string;
          price_per_meal_paise?: number | null;
          qty?: number;
          run_id?: string | null;
          service_date?: string;
          skip_reason?: string | null;
          slot?: Database['public']['Enums']['meal_slot'];
          status?: Database['public']['Enums']['order_status'];
          stop_id?: string | null;
          stop_seq?: number | null;
          subscription_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'meal_orders_address_id_kitchen_id_fkey';
            columns: ['address_id', 'kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'addresses';
            referencedColumns: ['id', 'kitchen_id'];
          },
          {
            foreignKeyName: 'meal_orders_change_id_fkey';
            columns: ['change_id'];
            isOneToOne: false;
            referencedRelation: 'schedule_changes';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'meal_orders_customer_id_kitchen_id_fkey';
            columns: ['customer_id', 'kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'customers';
            referencedColumns: ['id', 'kitchen_id'];
          },
          {
            foreignKeyName: 'meal_orders_customer_id_kitchen_id_fkey';
            columns: ['customer_id', 'kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'customers_v';
            referencedColumns: ['id', 'kitchen_id'];
          },
          {
            foreignKeyName: 'meal_orders_plan_id_kitchen_id_fkey';
            columns: ['plan_id', 'kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'plans';
            referencedColumns: ['id', 'kitchen_id'];
          },
          {
            foreignKeyName: 'meal_orders_run_fk';
            columns: ['run_id', 'kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'delivery_runs';
            referencedColumns: ['id', 'kitchen_id'];
          },
          {
            foreignKeyName: 'meal_orders_stop_fk';
            columns: ['stop_id', 'kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'delivery_stops';
            referencedColumns: ['id', 'kitchen_id'];
          },
          {
            foreignKeyName: 'meal_orders_subscription_id_kitchen_id_fkey';
            columns: ['subscription_id', 'kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'subscriptions';
            referencedColumns: ['id', 'kitchen_id'];
          },
        ];
      };
      member_invites: {
        Row: {
          accepted_at: string | null;
          accepted_user_id: string | null;
          created_at: string;
          display_name: string | null;
          id: string;
          invited_by: string | null;
          kitchen_id: string;
          phone_e164: string;
          revoked_at: string | null;
          role: Database['public']['Enums']['member_role'];
        };
        ComputedFields: never;
        Insert: {
          accepted_at?: string | null;
          accepted_user_id?: string | null;
          created_at?: string;
          display_name?: string | null;
          id?: string;
          invited_by?: string | null;
          kitchen_id: string;
          phone_e164: string;
          revoked_at?: string | null;
          role: Database['public']['Enums']['member_role'];
        };
        Update: {
          accepted_at?: string | null;
          accepted_user_id?: string | null;
          created_at?: string;
          display_name?: string | null;
          id?: string;
          invited_by?: string | null;
          kitchen_id?: string;
          phone_e164?: string;
          revoked_at?: string | null;
          role?: Database['public']['Enums']['member_role'];
        };
        Relationships: [
          {
            foreignKeyName: 'member_invites_kitchen_id_fkey';
            columns: ['kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'kitchens';
            referencedColumns: ['id'];
          },
        ];
      };
      members: {
        Row: {
          created_at: string;
          display_name: string | null;
          id: string;
          kitchen_id: string;
          role: Database['public']['Enums']['member_role'];
          updated_at: string;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          display_name?: string | null;
          id?: string;
          kitchen_id: string;
          role: Database['public']['Enums']['member_role'];
          updated_at?: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          display_name?: string | null;
          id?: string;
          kitchen_id?: string;
          role?: Database['public']['Enums']['member_role'];
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'members_kitchen_id_fkey';
            columns: ['kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'kitchens';
            referencedColumns: ['id'];
          },
        ];
      };
      menus: {
        Row: {
          created_at: string;
          dishes: string[];
          id: string;
          kitchen_id: string;
          notes: string | null;
          published: boolean;
          service_date: string;
          slot: Database['public']['Enums']['meal_slot'];
          updated_at: string;
          updated_by: string | null;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          dishes?: string[];
          id?: string;
          kitchen_id: string;
          notes?: string | null;
          published?: boolean;
          service_date: string;
          slot: Database['public']['Enums']['meal_slot'];
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: {
          created_at?: string;
          dishes?: string[];
          id?: string;
          kitchen_id?: string;
          notes?: string | null;
          published?: boolean;
          service_date?: string;
          slot?: Database['public']['Enums']['meal_slot'];
          updated_at?: string;
          updated_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'menus_kitchen_id_fkey';
            columns: ['kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'kitchens';
            referencedColumns: ['id'];
          },
        ];
      };
      messages: {
        Row: {
          body: string | null;
          bot_intent: string | null;
          conversation_id: string;
          created_at: string;
          direction: string;
          handled_by: string;
          id: string;
          kitchen_id: string | null;
          payload: NonNullable<Json>;
          sent_by: string | null;
          status: string;
          wa_message_id: string | null;
        };
        ComputedFields: never;
        Insert: {
          body?: string | null;
          bot_intent?: string | null;
          conversation_id: string;
          created_at?: string;
          direction: string;
          handled_by: string;
          id?: string;
          kitchen_id?: string | null;
          payload?: NonNullable<Json>;
          sent_by?: string | null;
          status?: string;
          wa_message_id?: string | null;
        };
        Update: {
          body?: string | null;
          bot_intent?: string | null;
          conversation_id?: string;
          created_at?: string;
          direction?: string;
          handled_by?: string;
          id?: string;
          kitchen_id?: string | null;
          payload?: NonNullable<Json>;
          sent_by?: string | null;
          status?: string;
          wa_message_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'messages_conversation_id_fkey';
            columns: ['conversation_id'];
            isOneToOne: false;
            referencedRelation: 'conversations';
            referencedColumns: ['id'];
          },
        ];
      };
      notifications_outbox: {
        Row: {
          attempts: number;
          channel: string;
          created_at: string;
          dedupe_key: string | null;
          id: string;
          kitchen_id: string | null;
          last_error: string | null;
          payload: NonNullable<Json>;
          recipient_id: string;
          recipient_type: string;
          send_after: string;
          sent_at: string | null;
          status: string;
          template: string;
        };
        ComputedFields: never;
        Insert: {
          attempts?: number;
          channel: string;
          created_at?: string;
          dedupe_key?: string | null;
          id?: string;
          kitchen_id?: string | null;
          last_error?: string | null;
          payload?: NonNullable<Json>;
          recipient_id: string;
          recipient_type: string;
          send_after?: string;
          sent_at?: string | null;
          status?: string;
          template: string;
        };
        Update: {
          attempts?: number;
          channel?: string;
          created_at?: string;
          dedupe_key?: string | null;
          id?: string;
          kitchen_id?: string | null;
          last_error?: string | null;
          payload?: NonNullable<Json>;
          recipient_id?: string;
          recipient_type?: string;
          send_after?: string;
          sent_at?: string | null;
          status?: string;
          template?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'notifications_outbox_kitchen_id_fkey';
            columns: ['kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'kitchens';
            referencedColumns: ['id'];
          },
        ];
      };
      payments: {
        Row: {
          amount_paise: number;
          collected_by: string | null;
          confirmed_at: string | null;
          confirmed_by: string | null;
          created_at: string;
          created_by: string | null;
          customer_id: string;
          description: string | null;
          expires_at: string | null;
          id: string;
          kitchen_id: string;
          meal_order_id: string | null;
          meals: number;
          method: Database['public']['Enums']['payment_method'];
          note: string | null;
          paid_at: string | null;
          razorpay_order_id: string | null;
          razorpay_payment_id: string | null;
          razorpay_payment_link_id: string | null;
          receipt_photo_path: string | null;
          settled_to_account: string | null;
          short_url: string | null;
          status: Database['public']['Enums']['payment_status'];
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          amount_paise: number;
          collected_by?: string | null;
          confirmed_at?: string | null;
          confirmed_by?: string | null;
          created_at?: string;
          created_by?: string | null;
          customer_id: string;
          description?: string | null;
          expires_at?: string | null;
          id?: string;
          kitchen_id: string;
          meal_order_id?: string | null;
          meals: number;
          method: Database['public']['Enums']['payment_method'];
          note?: string | null;
          paid_at?: string | null;
          razorpay_order_id?: string | null;
          razorpay_payment_id?: string | null;
          razorpay_payment_link_id?: string | null;
          receipt_photo_path?: string | null;
          settled_to_account?: string | null;
          short_url?: string | null;
          status: Database['public']['Enums']['payment_status'];
          updated_at?: string;
        };
        Update: {
          amount_paise?: number;
          collected_by?: string | null;
          confirmed_at?: string | null;
          confirmed_by?: string | null;
          created_at?: string;
          created_by?: string | null;
          customer_id?: string;
          description?: string | null;
          expires_at?: string | null;
          id?: string;
          kitchen_id?: string;
          meal_order_id?: string | null;
          meals?: number;
          method?: Database['public']['Enums']['payment_method'];
          note?: string | null;
          paid_at?: string | null;
          razorpay_order_id?: string | null;
          razorpay_payment_id?: string | null;
          razorpay_payment_link_id?: string | null;
          receipt_photo_path?: string | null;
          settled_to_account?: string | null;
          short_url?: string | null;
          status?: Database['public']['Enums']['payment_status'];
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'payments_customer_id_kitchen_id_fkey';
            columns: ['customer_id', 'kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'customers';
            referencedColumns: ['id', 'kitchen_id'];
          },
          {
            foreignKeyName: 'payments_customer_id_kitchen_id_fkey';
            columns: ['customer_id', 'kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'customers_v';
            referencedColumns: ['id', 'kitchen_id'];
          },
          {
            foreignKeyName: 'payments_meal_order_id_kitchen_id_fkey';
            columns: ['meal_order_id', 'kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'meal_orders';
            referencedColumns: ['id', 'kitchen_id'];
          },
        ];
      };
      plans: {
        Row: {
          active: boolean;
          created_at: string;
          days_of_week: number[];
          days_per_week: number | null;
          description: string | null;
          diet: Database['public']['Enums']['diet_type'];
          id: string;
          kitchen_id: string;
          name: string;
          price_per_meal_paise: number;
          slots: Database['public']['Enums']['meal_slot'][];
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          active?: boolean;
          created_at?: string;
          days_of_week?: number[];
          days_per_week?: never;
          description?: string | null;
          diet?: Database['public']['Enums']['diet_type'];
          id?: string;
          kitchen_id: string;
          name: string;
          price_per_meal_paise: number;
          slots: Database['public']['Enums']['meal_slot'][];
          updated_at?: string;
        };
        Update: {
          active?: boolean;
          created_at?: string;
          days_of_week?: number[];
          days_per_week?: never;
          description?: string | null;
          diet?: Database['public']['Enums']['diet_type'];
          id?: string;
          kitchen_id?: string;
          name?: string;
          price_per_meal_paise?: number;
          slots?: Database['public']['Enums']['meal_slot'][];
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'plans_kitchen_id_fkey';
            columns: ['kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'kitchens';
            referencedColumns: ['id'];
          },
        ];
      };
      platform_admins: {
        Row: {
          created_at: string;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      purchase_lines: {
        Row: {
          amount_paise: number;
          id: string;
          item_id: string;
          kitchen_id: string;
          price_jump_pct: number | null;
          purchase_id: string;
          qty: number;
          unit_price_paise: number;
        };
        ComputedFields: never;
        Insert: {
          amount_paise: number;
          id?: string;
          item_id: string;
          kitchen_id: string;
          price_jump_pct?: number | null;
          purchase_id: string;
          qty: number;
          unit_price_paise: number;
        };
        Update: {
          amount_paise?: number;
          id?: string;
          item_id?: string;
          kitchen_id?: string;
          price_jump_pct?: number | null;
          purchase_id?: string;
          qty?: number;
          unit_price_paise?: number;
        };
        Relationships: [
          {
            foreignKeyName: 'purchase_lines_item_id_kitchen_id_fkey';
            columns: ['item_id', 'kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'items';
            referencedColumns: ['id', 'kitchen_id'];
          },
          {
            foreignKeyName: 'purchase_lines_purchase_id_kitchen_id_fkey';
            columns: ['purchase_id', 'kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'purchases';
            referencedColumns: ['id', 'kitchen_id'];
          },
        ];
      };
      purchases: {
        Row: {
          bill_date: string;
          bill_no: string | null;
          bill_photo_path: string | null;
          created_at: string;
          created_by: string | null;
          id: string;
          kitchen_id: string;
          notes: string | null;
          supplier_id: string | null;
          total_paise: number;
        };
        ComputedFields: never;
        Insert: {
          bill_date: string;
          bill_no?: string | null;
          bill_photo_path?: string | null;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          kitchen_id: string;
          notes?: string | null;
          supplier_id?: string | null;
          total_paise: number;
        };
        Update: {
          bill_date?: string;
          bill_no?: string | null;
          bill_photo_path?: string | null;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          kitchen_id?: string;
          notes?: string | null;
          supplier_id?: string | null;
          total_paise?: number;
        };
        Relationships: [
          {
            foreignKeyName: 'purchases_kitchen_id_fkey';
            columns: ['kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'kitchens';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'purchases_supplier_id_kitchen_id_fkey';
            columns: ['supplier_id', 'kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'suppliers';
            referencedColumns: ['id', 'kitchen_id'];
          },
        ];
      };
      recipe_lines: {
        Row: {
          dish_id: string;
          id: string;
          item_id: string;
          kitchen_id: string;
          qty_per_portion: number;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          dish_id: string;
          id?: string;
          item_id: string;
          kitchen_id: string;
          qty_per_portion: number;
          updated_at?: string;
        };
        Update: {
          dish_id?: string;
          id?: string;
          item_id?: string;
          kitchen_id?: string;
          qty_per_portion?: number;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'recipe_lines_dish_id_kitchen_id_fkey';
            columns: ['dish_id', 'kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'dishes';
            referencedColumns: ['id', 'kitchen_id'];
          },
          {
            foreignKeyName: 'recipe_lines_item_id_kitchen_id_fkey';
            columns: ['item_id', 'kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'items';
            referencedColumns: ['id', 'kitchen_id'];
          },
        ];
      };
      refunds: {
        Row: {
          amount_paise: number;
          created_at: string;
          created_by: string | null;
          customer_id: string;
          id: string;
          kitchen_id: string;
          meals: number;
          method: Database['public']['Enums']['refund_method'] | null;
          note: string | null;
          payment_id: string | null;
          processed_at: string | null;
          processed_by: string | null;
          razorpay_refund_id: string | null;
          reason: string;
          status: Database['public']['Enums']['refund_status'];
          subscription_id: string | null;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          amount_paise: number;
          created_at?: string;
          created_by?: string | null;
          customer_id: string;
          id?: string;
          kitchen_id: string;
          meals: number;
          method?: Database['public']['Enums']['refund_method'] | null;
          note?: string | null;
          payment_id?: string | null;
          processed_at?: string | null;
          processed_by?: string | null;
          razorpay_refund_id?: string | null;
          reason: string;
          status?: Database['public']['Enums']['refund_status'];
          subscription_id?: string | null;
          updated_at?: string;
        };
        Update: {
          amount_paise?: number;
          created_at?: string;
          created_by?: string | null;
          customer_id?: string;
          id?: string;
          kitchen_id?: string;
          meals?: number;
          method?: Database['public']['Enums']['refund_method'] | null;
          note?: string | null;
          payment_id?: string | null;
          processed_at?: string | null;
          processed_by?: string | null;
          razorpay_refund_id?: string | null;
          reason?: string;
          status?: Database['public']['Enums']['refund_status'];
          subscription_id?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'refunds_customer_id_kitchen_id_fkey';
            columns: ['customer_id', 'kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'customers';
            referencedColumns: ['id', 'kitchen_id'];
          },
          {
            foreignKeyName: 'refunds_customer_id_kitchen_id_fkey';
            columns: ['customer_id', 'kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'customers_v';
            referencedColumns: ['id', 'kitchen_id'];
          },
          {
            foreignKeyName: 'refunds_payment_id_kitchen_id_fkey';
            columns: ['payment_id', 'kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'payments';
            referencedColumns: ['id', 'kitchen_id'];
          },
          {
            foreignKeyName: 'refunds_subscription_id_kitchen_id_fkey';
            columns: ['subscription_id', 'kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'subscriptions';
            referencedColumns: ['id', 'kitchen_id'];
          },
        ];
      };
      route_stops: {
        Row: {
          address_id: string;
          id: string;
          kitchen_id: string;
          pinned: boolean;
          route_id: string;
          seq: number;
          slot: Database['public']['Enums']['meal_slot'];
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          address_id: string;
          id?: string;
          kitchen_id: string;
          pinned?: boolean;
          route_id: string;
          seq: number;
          slot: Database['public']['Enums']['meal_slot'];
          updated_at?: string;
        };
        Update: {
          address_id?: string;
          id?: string;
          kitchen_id?: string;
          pinned?: boolean;
          route_id?: string;
          seq?: number;
          slot?: Database['public']['Enums']['meal_slot'];
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'route_stops_address_id_kitchen_id_fkey';
            columns: ['address_id', 'kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'addresses';
            referencedColumns: ['id', 'kitchen_id'];
          },
          {
            foreignKeyName: 'route_stops_route_id_kitchen_id_slot_fkey';
            columns: ['route_id', 'kitchen_id', 'slot'];
            isOneToOne: false;
            referencedRelation: 'delivery_routes';
            referencedColumns: ['id', 'kitchen_id', 'slot'];
          },
        ];
      };
      schedule_changes: {
        Row: {
          address_id: string | null;
          after_cutoff: boolean;
          channel: Database['public']['Enums']['change_channel'];
          from_date: string;
          id: string;
          kitchen_id: string;
          late_waived: boolean;
          note: string | null;
          requested_at: string;
          requested_by: string | null;
          slot: Database['public']['Enums']['meal_slot'] | null;
          subscription_id: string;
          to_date: string | null;
          type: Database['public']['Enums']['change_type'];
        };
        ComputedFields: never;
        Insert: {
          address_id?: string | null;
          after_cutoff?: boolean;
          channel: Database['public']['Enums']['change_channel'];
          from_date: string;
          id?: string;
          kitchen_id: string;
          late_waived?: boolean;
          note?: string | null;
          requested_at?: string;
          requested_by?: string | null;
          slot?: Database['public']['Enums']['meal_slot'] | null;
          subscription_id: string;
          to_date?: string | null;
          type: Database['public']['Enums']['change_type'];
        };
        Update: {
          address_id?: string | null;
          after_cutoff?: boolean;
          channel?: Database['public']['Enums']['change_channel'];
          from_date?: string;
          id?: string;
          kitchen_id?: string;
          late_waived?: boolean;
          note?: string | null;
          requested_at?: string;
          requested_by?: string | null;
          slot?: Database['public']['Enums']['meal_slot'] | null;
          subscription_id?: string;
          to_date?: string | null;
          type?: Database['public']['Enums']['change_type'];
        };
        Relationships: [
          {
            foreignKeyName: 'schedule_changes_address_id_kitchen_id_fkey';
            columns: ['address_id', 'kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'addresses';
            referencedColumns: ['id', 'kitchen_id'];
          },
          {
            foreignKeyName: 'schedule_changes_subscription_id_kitchen_id_fkey';
            columns: ['subscription_id', 'kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'subscriptions';
            referencedColumns: ['id', 'kitchen_id'];
          },
        ];
      };
      stock_moves: {
        Row: {
          created_at: string;
          created_by: string | null;
          id: number;
          item_id: string;
          kitchen_id: string;
          qty: number;
          reason: string | null;
          ref_id: string | null;
          ref_type: string | null;
          type: Database['public']['Enums']['stock_move_type'];
          unit_cost_paise: number | null;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          created_by?: string | null;
          id?: never;
          item_id: string;
          kitchen_id: string;
          qty: number;
          reason?: string | null;
          ref_id?: string | null;
          ref_type?: string | null;
          type: Database['public']['Enums']['stock_move_type'];
          unit_cost_paise?: number | null;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          id?: never;
          item_id?: string;
          kitchen_id?: string;
          qty?: number;
          reason?: string | null;
          ref_id?: string | null;
          ref_type?: string | null;
          type?: Database['public']['Enums']['stock_move_type'];
          unit_cost_paise?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: 'stock_moves_item_id_kitchen_id_fkey';
            columns: ['item_id', 'kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'items';
            referencedColumns: ['id', 'kitchen_id'];
          },
        ];
      };
      stock_take_lines: {
        Row: {
          counted_qty: number | null;
          expected_qty: number;
          item_id: string;
          kitchen_id: string;
          reason: string | null;
          stock_take_id: string;
          variance: number | null;
        };
        ComputedFields: never;
        Insert: {
          counted_qty?: number | null;
          expected_qty: number;
          item_id: string;
          kitchen_id: string;
          reason?: string | null;
          stock_take_id: string;
          variance?: never;
        };
        Update: {
          counted_qty?: number | null;
          expected_qty?: number;
          item_id?: string;
          kitchen_id?: string;
          reason?: string | null;
          stock_take_id?: string;
          variance?: never;
        };
        Relationships: [
          {
            foreignKeyName: 'stock_take_lines_item_id_kitchen_id_fkey';
            columns: ['item_id', 'kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'items';
            referencedColumns: ['id', 'kitchen_id'];
          },
          {
            foreignKeyName: 'stock_take_lines_stock_take_id_kitchen_id_fkey';
            columns: ['stock_take_id', 'kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'stock_takes';
            referencedColumns: ['id', 'kitchen_id'];
          },
        ];
      };
      stock_takes: {
        Row: {
          closed_at: string | null;
          closed_by: string | null;
          created_by: string | null;
          id: string;
          kitchen_id: string;
          started_at: string;
          status: string;
        };
        ComputedFields: never;
        Insert: {
          closed_at?: string | null;
          closed_by?: string | null;
          created_by?: string | null;
          id?: string;
          kitchen_id: string;
          started_at?: string;
          status?: string;
        };
        Update: {
          closed_at?: string | null;
          closed_by?: string | null;
          created_by?: string | null;
          id?: string;
          kitchen_id?: string;
          started_at?: string;
          status?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'stock_takes_kitchen_id_fkey';
            columns: ['kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'kitchens';
            referencedColumns: ['id'];
          },
        ];
      };
      subscription_events: {
        Row: {
          actor_id: string | null;
          created_at: string;
          from_status: Database['public']['Enums']['subscription_status'] | null;
          id: number;
          kitchen_id: string;
          reason: string | null;
          subscription_id: string;
          to_status: Database['public']['Enums']['subscription_status'];
        };
        ComputedFields: never;
        Insert: {
          actor_id?: string | null;
          created_at?: string;
          from_status?: Database['public']['Enums']['subscription_status'] | null;
          id?: never;
          kitchen_id: string;
          reason?: string | null;
          subscription_id: string;
          to_status: Database['public']['Enums']['subscription_status'];
        };
        Update: {
          actor_id?: string | null;
          created_at?: string;
          from_status?: Database['public']['Enums']['subscription_status'] | null;
          id?: never;
          kitchen_id?: string;
          reason?: string | null;
          subscription_id?: string;
          to_status?: Database['public']['Enums']['subscription_status'];
        };
        Relationships: [
          {
            foreignKeyName: 'subscription_events_subscription_id_kitchen_id_fkey';
            columns: ['subscription_id', 'kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'subscriptions';
            referencedColumns: ['id', 'kitchen_id'];
          },
        ];
      };
      subscriptions: {
        Row: {
          address_id: string | null;
          autopay_mandate_id: string | null;
          cancelled_at: string | null;
          created_at: string;
          customer_id: string;
          end_date: string | null;
          id: string;
          kitchen_id: string;
          plan_id: string;
          qty: number;
          start_date: string;
          status: Database['public']['Enums']['subscription_status'];
          status_changed_at: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          address_id?: string | null;
          autopay_mandate_id?: string | null;
          cancelled_at?: string | null;
          created_at?: string;
          customer_id: string;
          end_date?: string | null;
          id?: string;
          kitchen_id: string;
          plan_id: string;
          qty?: number;
          start_date: string;
          status?: Database['public']['Enums']['subscription_status'];
          status_changed_at?: string;
          updated_at?: string;
        };
        Update: {
          address_id?: string | null;
          autopay_mandate_id?: string | null;
          cancelled_at?: string | null;
          created_at?: string;
          customer_id?: string;
          end_date?: string | null;
          id?: string;
          kitchen_id?: string;
          plan_id?: string;
          qty?: number;
          start_date?: string;
          status?: Database['public']['Enums']['subscription_status'];
          status_changed_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'subscriptions_address_id_kitchen_id_fkey';
            columns: ['address_id', 'kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'addresses';
            referencedColumns: ['id', 'kitchen_id'];
          },
          {
            foreignKeyName: 'subscriptions_customer_id_kitchen_id_fkey';
            columns: ['customer_id', 'kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'customers';
            referencedColumns: ['id', 'kitchen_id'];
          },
          {
            foreignKeyName: 'subscriptions_customer_id_kitchen_id_fkey';
            columns: ['customer_id', 'kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'customers_v';
            referencedColumns: ['id', 'kitchen_id'];
          },
          {
            foreignKeyName: 'subscriptions_kitchen_id_fkey';
            columns: ['kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'kitchens';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'subscriptions_plan_id_kitchen_id_fkey';
            columns: ['plan_id', 'kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'plans';
            referencedColumns: ['id', 'kitchen_id'];
          },
        ];
      };
      supplier_payments: {
        Row: {
          amount_paise: number;
          created_by: string | null;
          id: string;
          kitchen_id: string;
          method: Database['public']['Enums']['payment_method'];
          note: string | null;
          paid_at: string;
          purchase_id: string | null;
          supplier_id: string;
        };
        ComputedFields: never;
        Insert: {
          amount_paise: number;
          created_by?: string | null;
          id?: string;
          kitchen_id: string;
          method?: Database['public']['Enums']['payment_method'];
          note?: string | null;
          paid_at?: string;
          purchase_id?: string | null;
          supplier_id: string;
        };
        Update: {
          amount_paise?: number;
          created_by?: string | null;
          id?: string;
          kitchen_id?: string;
          method?: Database['public']['Enums']['payment_method'];
          note?: string | null;
          paid_at?: string;
          purchase_id?: string | null;
          supplier_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'supplier_payments_purchase_id_kitchen_id_fkey';
            columns: ['purchase_id', 'kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'purchases';
            referencedColumns: ['id', 'kitchen_id'];
          },
          {
            foreignKeyName: 'supplier_payments_supplier_id_kitchen_id_fkey';
            columns: ['supplier_id', 'kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'suppliers';
            referencedColumns: ['id', 'kitchen_id'];
          },
        ];
      };
      suppliers: {
        Row: {
          active: boolean;
          created_at: string;
          id: string;
          kitchen_id: string;
          name: string;
          notes: string | null;
          phone: string | null;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          active?: boolean;
          created_at?: string;
          id?: string;
          kitchen_id: string;
          name: string;
          notes?: string | null;
          phone?: string | null;
          updated_at?: string;
        };
        Update: {
          active?: boolean;
          created_at?: string;
          id?: string;
          kitchen_id?: string;
          name?: string;
          notes?: string | null;
          phone?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'suppliers_kitchen_id_fkey';
            columns: ['kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'kitchens';
            referencedColumns: ['id'];
          },
        ];
      };
      tiffin_ledger: {
        Row: {
          created_at: string;
          created_by: string | null;
          customer_id: string;
          id: string;
          kitchen_id: string;
          note: string | null;
          stop_id: string | null;
          tiffins_out: number;
          tiffins_returned: number;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          created_by?: string | null;
          customer_id: string;
          id?: string;
          kitchen_id: string;
          note?: string | null;
          stop_id?: string | null;
          tiffins_out?: number;
          tiffins_returned?: number;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          customer_id?: string;
          id?: string;
          kitchen_id?: string;
          note?: string | null;
          stop_id?: string | null;
          tiffins_out?: number;
          tiffins_returned?: number;
        };
        Relationships: [
          {
            foreignKeyName: 'tiffin_ledger_customer_id_kitchen_id_fkey';
            columns: ['customer_id', 'kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'customers';
            referencedColumns: ['id', 'kitchen_id'];
          },
          {
            foreignKeyName: 'tiffin_ledger_customer_id_kitchen_id_fkey';
            columns: ['customer_id', 'kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'customers_v';
            referencedColumns: ['id', 'kitchen_id'];
          },
          {
            foreignKeyName: 'tiffin_ledger_stop_id_kitchen_id_fkey';
            columns: ['stop_id', 'kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'delivery_stops';
            referencedColumns: ['id', 'kitchen_id'];
          },
        ];
      };
      vendor_applications: {
        Row: {
          area: string | null;
          bot_step: string | null;
          campaign: string | null;
          consent_at: string;
          created_at: string;
          fssai_no: string | null;
          id: string;
          kitchen_id: string | null;
          kitchen_name: string | null;
          last_nudged_at: string | null;
          lat: number | null;
          lng: number | null;
          name: string;
          notes: string | null;
          nudges: number;
          phone_enc: string;
          phone_hash: string;
          phone_last4: string;
          source: Database['public']['Enums']['lead_source'];
          status: Database['public']['Enums']['vendor_app_status'];
          subscribers_estimate: number | null;
          updated_at: string;
          whatsapp_opt_in: boolean;
        };
        ComputedFields: never;
        Insert: {
          area?: string | null;
          bot_step?: string | null;
          campaign?: string | null;
          consent_at: string;
          created_at?: string;
          fssai_no?: string | null;
          id?: string;
          kitchen_id?: string | null;
          kitchen_name?: string | null;
          last_nudged_at?: string | null;
          lat?: number | null;
          lng?: number | null;
          name: string;
          notes?: string | null;
          nudges?: number;
          phone_enc: string;
          phone_hash: string;
          phone_last4: string;
          source?: Database['public']['Enums']['lead_source'];
          status?: Database['public']['Enums']['vendor_app_status'];
          subscribers_estimate?: number | null;
          updated_at?: string;
          whatsapp_opt_in?: boolean;
        };
        Update: {
          area?: string | null;
          bot_step?: string | null;
          campaign?: string | null;
          consent_at?: string;
          created_at?: string;
          fssai_no?: string | null;
          id?: string;
          kitchen_id?: string | null;
          kitchen_name?: string | null;
          last_nudged_at?: string | null;
          lat?: number | null;
          lng?: number | null;
          name?: string;
          notes?: string | null;
          nudges?: number;
          phone_enc?: string;
          phone_hash?: string;
          phone_last4?: string;
          source?: Database['public']['Enums']['lead_source'];
          status?: Database['public']['Enums']['vendor_app_status'];
          subscribers_estimate?: number | null;
          updated_at?: string;
          whatsapp_opt_in?: boolean;
        };
        Relationships: [
          {
            foreignKeyName: 'vendor_applications_kitchen_id_fkey';
            columns: ['kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'kitchens';
            referencedColumns: ['id'];
          },
        ];
      };
      webhook_events: {
        Row: {
          event_id: string;
          event_type: string | null;
          id: number;
          payload: NonNullable<Json>;
          processed_at: string | null;
          provider: string;
          received_at: string;
          result: string | null;
        };
        ComputedFields: never;
        Insert: {
          event_id: string;
          event_type?: string | null;
          id?: never;
          payload: NonNullable<Json>;
          processed_at?: string | null;
          provider: string;
          received_at?: string;
          result?: string | null;
        };
        Update: {
          event_id?: string;
          event_type?: string | null;
          id?: never;
          payload?: NonNullable<Json>;
          processed_at?: string | null;
          provider?: string;
          received_at?: string;
          result?: string | null;
        };
        Relationships: [];
      };
    };
    Views: {
      customer_balances: {
        Row: {
          amount_paise: number | null;
          customer_id: string;
          kitchen_id: string;
          meals: number | null;
        };
        ComputedFields: never;
        Relationships: [
          {
            foreignKeyName: 'balance_entries_customer_id_kitchen_id_fkey';
            columns: ['customer_id', 'kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'customers';
            referencedColumns: ['id', 'kitchen_id'];
          },
          {
            foreignKeyName: 'balance_entries_customer_id_kitchen_id_fkey';
            columns: ['customer_id', 'kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'customers_v';
            referencedColumns: ['id', 'kitchen_id'];
          },
        ];
      };
      customers_v: {
        Row: {
          address_id: string | null;
          area: string | null;
          consent_at: string | null;
          created_at: string;
          delivery_notes: string | null;
          diet: Database['public']['Enums']['diet_type'];
          id: string;
          kitchen_id: string;
          landmark: string | null;
          lat: number | null;
          line1: string | null;
          lng: number | null;
          name: string;
          notes: string | null;
          phone: string | null;
          phone_last4: string | null;
          platform_sourced: boolean;
          preferred_language: Database['public']['Enums']['language_code'];
          source: Database['public']['Enums']['customer_source'];
          updated_at: string;
          whatsapp_opt_in: boolean;
        };
        ComputedFields: never;
        Relationships: [
          {
            foreignKeyName: 'customers_kitchen_id_fkey';
            columns: ['kitchen_id'];
            isOneToOne: false;
            referencedRelation: 'kitchens';
            referencedColumns: ['id'];
          },
        ];
      };
    };
    Functions: {
      add_balance_entry: {
        Args: {
          p_customer: string;
          p_meals: number;
          p_reason: string;
          p_type: Database['public']['Enums']['balance_entry_type'];
        };
        Returns: string;
      };
      adjust_stock: {
        Args: {
          p_item: string;
          p_qty: number;
          p_reason: string;
          p_unit?: Database['public']['Enums']['stock_unit'];
        };
        Returns: undefined;
      };
      admin_assign_lead: {
        Args: { p_kitchen: string; p_lead: string; p_plan?: string };
        Returns: Json;
      };
      admin_audit_log: {
        Args: {
          p_action?: string;
          p_before?: string;
          p_kitchen?: string;
          p_limit?: number;
          p_table?: string;
        };
        Returns: Json;
      };
      admin_create_lead: {
        Args: {
          p_area?: string;
          p_budget_paise?: number;
          p_campaign?: string;
          p_diet?: Database['public']['Enums']['diet_type'];
          p_name: string;
          p_notes?: string;
          p_phone: string;
          p_slots?: Database['public']['Enums']['meal_slot'][];
          p_source?: Database['public']['Enums']['lead_source'];
          p_start?: string;
          p_whatsapp_opt_in?: boolean;
        };
        Returns: Json;
      };
      admin_hide_review: { Args: { p_hidden: boolean; p_review: string }; Returns: undefined };
      admin_kitchens: { Args: Record<PropertyKey, never>; Returns: Json };
      admin_lead_detail: { Args: { p_lead: string }; Returns: Json };
      admin_leads: {
        Args: {
          p_limit?: number;
          p_search?: string;
          p_source?: Database['public']['Enums']['lead_source'];
          p_status?: Database['public']['Enums']['lead_status'];
        };
        Returns: Json;
      };
      admin_match_lead: { Args: { p_lead: string }; Returns: Json };
      admin_reveal_lead_phone: { Args: { p_lead: string }; Returns: string };
      admin_reveal_vendor_phone: { Args: { p_id: string }; Returns: string };
      admin_reviews: { Args: { p_kitchen?: string; p_limit?: number }; Returns: Json };
      admin_set_fssai: { Args: { p_fssai: string; p_kitchen: string }; Returns: undefined };
      admin_set_lead_status: {
        Args: {
          p_lead: string;
          p_reason?: string;
          p_status: Database['public']['Enums']['lead_status'];
        };
        Returns: undefined;
      };
      admin_update_vendor_application: {
        Args: {
          p_id: string;
          p_notes?: string;
          p_status?: Database['public']['Enums']['vendor_app_status'];
        };
        Returns: undefined;
      };
      admin_vendor_applications: {
        Args: { p_status?: Database['public']['Enums']['vendor_app_status'] };
        Returns: Json;
      };
      assign_run: { Args: { p_rider?: string; p_run: string }; Returns: undefined };
      attach_payment_link: {
        Args: { p_expires_at: string; p_link_id: string; p_payment: string; p_short_url: string };
        Returns: undefined;
      };
      cancel_stock_take: { Args: { p_stock_take: string }; Returns: undefined };
      change_feed: {
        Args: { p_kitchen: string; p_limit?: number; p_since?: string };
        Returns: {
          after_cutoff: boolean;
          change_id: string;
          channel: Database['public']['Enums']['change_channel'];
          customer_id: string;
          customer_name: string;
          from_date: string;
          late_waived: boolean;
          plan_name: string;
          requested_at: string;
          slot: Database['public']['Enums']['meal_slot'];
          to_date: string;
          type: Database['public']['Enums']['change_type'];
        }[];
      };
      claim_invites: { Args: Record<PropertyKey, never>; Returns: number };
      close_conversation: { Args: { p_conversation: string }; Returns: undefined };
      close_stock_take: { Args: { p_stock_take: string }; Returns: Json };
      complete_stop: {
        Args: {
          p_accuracy?: number;
          p_at?: string;
          p_cash_paise?: number;
          p_client_op?: string;
          p_lat?: number;
          p_lng?: number;
          p_offline?: boolean;
          p_otp?: string;
          p_photo_path?: string;
          p_proof: Database['public']['Enums']['proof_type'];
          p_stop: string;
          p_tiffins_out?: number;
          p_tiffins_returned?: number;
        };
        Returns: Json;
      };
      confirm_payment: { Args: { p_meals?: number; p_payment: string }; Returns: undefined };
      cost_report: { Args: { p_from: string; p_kitchen: string; p_to: string }; Returns: Json };
      create_customer: {
        Args: {
          p_address?: Json;
          p_consent: boolean;
          p_diet?: Database['public']['Enums']['diet_type'];
          p_kitchen: string;
          p_language?: Database['public']['Enums']['language_code'];
          p_name: string;
          p_notes?: string;
          p_phone: string;
        };
        Returns: string;
      };
      create_item: {
        Args: {
          p_category?: Database['public']['Enums']['item_category'];
          p_kitchen: string;
          p_min_qty?: number;
          p_name: string;
          p_opening_price_paise?: number;
          p_opening_qty?: number;
          p_unit: Database['public']['Enums']['stock_unit'];
        };
        Returns: string;
      };
      create_kitchen: {
        Args: {
          p_address?: string;
          p_area?: string;
          p_fssai_no?: string;
          p_lat?: number;
          p_lng?: number;
          p_name: string;
          p_owner_name?: string;
          p_slug?: string;
        };
        Returns: {
          accepts_platform_leads: boolean;
          address: string | null;
          area: string | null;
          capacity_dinner: number;
          capacity_lunch: number;
          city: string;
          created_at: string;
          cuisine_tags: string[];
          cutoff_dinner: string;
          cutoff_dinner_prev_day: boolean;
          cutoff_lunch: string;
          cutoff_lunch_prev_day: boolean;
          description: string | null;
          fssai_no: string | null;
          geo_point: unknown;
          id: string;
          lat: number | null;
          lng: number | null;
          name: string;
          owner_id: string;
          photo_paths: string[];
          service_radius_km: number;
          slug: string;
          status: Database['public']['Enums']['kitchen_status'];
          trial_meals: number;
          updated_at: string;
          weekly_off: number[];
        };
        SetofOptions: {
          from: '*';
          to: 'kitchens';
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      create_payment_link_record: {
        Args: { p_customer: string; p_description?: string; p_meals: number };
        Returns: Json;
      };
      create_route: {
        Args: {
          p_kitchen: string;
          p_name: string;
          p_rider?: string;
          p_slot: Database['public']['Enums']['meal_slot'];
        };
        Returns: string;
      };
      customer_page_link: { Args: { p_customer: string }; Returns: string };
      customer_phone: { Args: { p_customer: string }; Returns: string };
      demand_gaps: {
        Args: Record<PropertyKey, never>;
        Returns: {
          area: string;
          dinner: number;
          lunch: number;
          nearest_kitchen: string;
          nearest_km: number;
          open_applications: number;
          waiting: number;
        }[];
      };
      dish_costs: { Args: { p_kitchen: string }; Returns: Json };
      dues_list: {
        Args: { p_kitchen: string };
        Returns: {
          amount_owed_paise: number;
          customer_id: string;
          customer_name: string;
          meals_owed: number;
          since: string;
        }[];
      };
      erase_customer: { Args: { p_customer: string }; Returns: undefined };
      fail_stop: {
        Args: {
          p_at?: string;
          p_client_op?: string;
          p_lat?: number;
          p_lng?: number;
          p_note?: string;
          p_offline?: boolean;
          p_reason: Database['public']['Enums']['fail_reason'];
          p_stop: string;
          p_tiffins_returned?: number;
        };
        Returns: Json;
      };
      finish_run: { Args: { p_at?: string; p_run: string }; Returns: undefined };
      import_customers: {
        Args: { p_consent: boolean; p_file_name?: string; p_kitchen: string; p_rows: Json };
        Returns: Json;
      };
      inventory_alerts: { Args: { p_kitchen: string }; Returns: Json };
      invite_member: {
        Args: {
          p_display_name?: string;
          p_kitchen: string;
          p_phone: string;
          p_role: Database['public']['Enums']['member_role'];
        };
        Returns: Json;
      };
      kitchen_checklist: { Args: { p_kitchen: string }; Returns: Json };
      kitchen_directory: { Args: { p_area?: string }; Returns: Json };
      kitchen_profile: { Args: { p_slug: string }; Returns: Json };
      lead_choose: { Args: { p_kitchen: string; p_token: string }; Returns: Json };
      lead_funnel: {
        Args: { p_from?: string; p_to?: string };
        Returns: {
          campaign: string;
          chose: number;
          converted: number;
          leads: number;
          lost: number;
          matched: number;
          qualified: number;
          renewed: number;
          source: Database['public']['Enums']['lead_source'];
          trial: number;
          waitlist: number;
        }[];
      };
      lead_ingest: {
        Args: {
          p_area?: string;
          p_campaign?: string;
          p_external_id: string;
          p_extra?: Json;
          p_name: string;
          p_phone: string;
          p_source: Database['public']['Enums']['lead_source'];
          p_whatsapp_opt_in?: boolean;
        };
        Returns: Json;
      };
      list_areas: { Args: Record<PropertyKey, never>; Returns: Json };
      live_board: {
        Args: {
          p_date: string;
          p_kitchen: string;
          p_slot: Database['public']['Enums']['meal_slot'];
        };
        Returns: Json;
      };
      mark_conversation_read: { Args: { p_conversation: string }; Returns: undefined };
      mark_refund_paid: {
        Args: {
          p_method: Database['public']['Enums']['refund_method'];
          p_note?: string;
          p_refund: string;
        };
        Returns: undefined;
      };
      mark_refund_submitted: {
        Args: { p_razorpay_refund_id: string; p_refund: string };
        Returns: undefined;
      };
      money_report: { Args: { p_from: string; p_kitchen: string; p_to: string }; Returns: Json };
      move_stop: { Args: { p_run: string; p_stop: string }; Returns: undefined };
      optimize_route: { Args: { p_route: string }; Returns: Json };
      packing_list: {
        Args: {
          p_date: string;
          p_kitchen: string;
          p_slot: Database['public']['Enums']['meal_slot'];
        };
        Returns: {
          area: string;
          charged: boolean;
          customer_name: string;
          customer_notes: string;
          delivery_notes: string;
          diet: Database['public']['Enums']['diet_type'];
          landmark: string;
          line1: string;
          order_id: string;
          plan_name: string;
          qty: number;
          status: Database['public']['Enums']['order_status'];
          stop_seq: number;
        }[];
      };
      pay_supplier: {
        Args: {
          p_amount_paise: number;
          p_method?: Database['public']['Enums']['payment_method'];
          p_note?: string;
          p_supplier: string;
        };
        Returns: string;
      };
      plan_runs: {
        Args: {
          p_date: string;
          p_kitchen: string;
          p_slot: Database['public']['Enums']['meal_slot'];
        };
        Returns: number;
      };
      platform_metrics: { Args: Record<PropertyKey, never>; Returns: Json };
      portal_add_address: {
        Args: {
          p_area: string;
          p_delivery_notes: string;
          p_landmark: string;
          p_lat?: number;
          p_line1: string;
          p_lng?: number;
          p_token: string;
        };
        Returns: string;
      };
      portal_change: {
        Args: {
          p_address?: string;
          p_dry_run?: boolean;
          p_from: string;
          p_slot?: Database['public']['Enums']['meal_slot'];
          p_subscription: string;
          p_to?: string;
          p_token: string;
          p_type: Database['public']['Enums']['change_type'];
        };
        Returns: Json;
      };
      portal_complaint: {
        Args: { p_category: string; p_description: string; p_token: string };
        Returns: string;
      };
      portal_get: { Args: { p_token: string }; Returns: Json };
      portal_payment_link_record: { Args: { p_meals: number; p_token: string }; Returns: Json };
      portal_review: {
        Args: { p_comment?: string; p_rating: number; p_token: string };
        Returns: undefined;
      };
      portal_set_language: {
        Args: { p_language: Database['public']['Enums']['language_code']; p_token: string };
        Returns: undefined;
      };
      production_plan: {
        Args: {
          p_date: string;
          p_kitchen: string;
          p_slot: Database['public']['Enums']['meal_slot'];
        };
        Returns: Json;
      };
      razorpay_process_event: { Args: { p_event_id: string; p_payload: Json }; Returns: string };
      record_cash_at_door: {
        Args: { p_amount_paise: number; p_meal_order: string; p_note?: string };
        Returns: string;
      };
      record_payment: {
        Args: {
          p_amount_paise: number;
          p_customer: string;
          p_meals?: number;
          p_method: Database['public']['Enums']['payment_method'];
          p_note?: string;
          p_receipt_photo_path?: string;
        };
        Returns: string;
      };
      record_purchase: {
        Args: {
          p_bill_date?: string;
          p_bill_no?: string;
          p_kitchen: string;
          p_lines: Json;
          p_notes?: string;
          p_paid_now_paise?: number;
          p_photo_path?: string;
          p_supplier?: string;
        };
        Returns: Json;
      };
      record_tiffins: {
        Args: { p_customer: string; p_note?: string; p_out: number; p_returned: number };
        Returns: string;
      };
      record_waste: {
        Args: {
          p_item: string;
          p_qty: number;
          p_reason: string;
          p_unit?: Database['public']['Enums']['stock_unit'];
        };
        Returns: undefined;
      };
      refund_for_gateway: { Args: { p_refund: string }; Returns: Json };
      refund_unused_meals: {
        Args: { p_customer: string; p_meals?: number; p_reason?: string };
        Returns: string;
      };
      reject_payment: { Args: { p_payment: string; p_reason: string }; Returns: undefined };
      remove_member: { Args: { p_member: string }; Returns: undefined };
      reorder_run: { Args: { p_run: string; p_stop_ids: string[] }; Returns: undefined };
      request_schedule_change: {
        Args: {
          p_address?: string;
          p_dry_run?: boolean;
          p_from?: string;
          p_note?: string;
          p_slot?: Database['public']['Enums']['meal_slot'];
          p_subscription: string;
          p_to?: string;
          p_type: Database['public']['Enums']['change_type'];
          p_waive_late?: boolean;
        };
        Returns: Json;
      };
      resolve_complaint: {
        Args: { p_complaint: string; p_credit_meals?: number; p_note: string };
        Returns: undefined;
      };
      reveal_customer_phone: { Args: { p_customer: string }; Returns: string };
      revoke_invite: { Args: { p_invite: string }; Returns: undefined };
      rider_call_number: { Args: { p_stop: string }; Returns: string };
      rider_ping: { Args: { p_lat: number; p_lng: number; p_run: string }; Returns: undefined };
      rider_stats: {
        Args: { p_kitchen: string; p_month: string };
        Returns: {
          cash_collected_paise: number;
          days: number;
          km: number;
          proof_rate: number;
          rider_id: string;
          rider_name: string;
          shifts: number;
          stops_delivered: number;
          stops_failed: number;
        }[];
      };
      rider_today: { Args: Record<PropertyKey, never>; Returns: Json };
      route_points: { Args: { p_route: string }; Returns: Json };
      save_route_order: {
        Args: { p_address_ids: string[]; p_pinned?: boolean; p_route: string };
        Returns: undefined;
      };
      search_customers: {
        Args: { p_kitchen: string; p_limit?: number; p_q: string };
        Returns: {
          address_id: string | null;
          area: string | null;
          consent_at: string | null;
          created_at: string;
          delivery_notes: string | null;
          diet: Database['public']['Enums']['diet_type'];
          id: string;
          kitchen_id: string;
          landmark: string | null;
          lat: number | null;
          line1: string | null;
          lng: number | null;
          name: string;
          notes: string | null;
          phone: string | null;
          phone_last4: string | null;
          platform_sourced: boolean;
          preferred_language: Database['public']['Enums']['language_code'];
          source: Database['public']['Enums']['customer_source'];
          updated_at: string;
          whatsapp_opt_in: boolean;
        }[];
        SetofOptions: {
          from: '*';
          to: 'customers_v';
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      send_broadcast: { Args: { p_body: string; p_kitchen: string }; Returns: number };
      send_vendor_message: { Args: { p_body: string; p_conversation: string }; Returns: string };
      set_kitchen_status: {
        Args: { p_kitchen: string; p_status: Database['public']['Enums']['kitchen_status'] };
        Returns: undefined;
      };
      set_member_role: {
        Args: { p_member: string; p_role: Database['public']['Enums']['member_role'] };
        Returns: undefined;
      };
      set_payout_account: {
        Args: { p_account_id: string; p_kitchen: string; p_kyc_status: string };
        Returns: undefined;
      };
      set_recipe_line: {
        Args: {
          p_dish: string;
          p_item: string;
          p_qty: number;
          p_unit?: Database['public']['Enums']['stock_unit'];
        };
        Returns: number;
      };
      set_stock_count: {
        Args: {
          p_counted?: number;
          p_item: string;
          p_reason?: string;
          p_stock_take: string;
          p_unit?: Database['public']['Enums']['stock_unit'];
        };
        Returns: Json;
      };
      slot_summary: {
        Args: {
          p_date: string;
          p_kitchen: string;
          p_slot: Database['public']['Enums']['meal_slot'];
        };
        Returns: Json;
      };
      start_run: { Args: { p_at?: string; p_run: string }; Returns: undefined };
      start_stock_take: { Args: { p_kitchen: string }; Returns: string };
      stock_levels: {
        Args: { p_kitchen: string };
        Returns: {
          active: boolean;
          category: Database['public']['Enums']['item_category'];
          item_id: string;
          low: boolean;
          min_qty: number;
          name: string;
          stock: number;
          unit: Database['public']['Enums']['stock_unit'];
          unit_cost_paise: number;
          value_paise: number;
        }[];
      };
      stock_take_review: { Args: { p_stock_take: string }; Returns: Json };
      submit_lead: {
        Args: {
          p_address?: string;
          p_area?: string;
          p_budget_paise?: number;
          p_campaign?: string;
          p_consent?: boolean;
          p_diet?: Database['public']['Enums']['diet_type'];
          p_language?: Database['public']['Enums']['language_code'];
          p_lat?: number;
          p_lng?: number;
          p_name: string;
          p_phone: string;
          p_slots?: Database['public']['Enums']['meal_slot'][];
          p_source?: Database['public']['Enums']['lead_source'];
          p_start?: string;
          p_whatsapp_opt_in?: boolean;
        };
        Returns: Json;
      };
      submit_vendor_application: {
        Args: {
          p_area?: string;
          p_campaign?: string;
          p_consent?: boolean;
          p_fssai?: string;
          p_kitchen_name?: string;
          p_name: string;
          p_phone: string;
          p_source?: Database['public']['Enums']['lead_source'];
          p_subscribers?: number;
          p_whatsapp_opt_in?: boolean;
        };
        Returns: string;
      };
      supplier_dues: {
        Args: { p_kitchen: string };
        Returns: {
          due_paise: number;
          last_bill_date: string;
          name: string;
          paid_paise: number;
          phone: string;
          purchased_paise: number;
          supplier_id: string;
        }[];
      };
      tiffin_balances: {
        Args: { p_kitchen: string };
        Returns: {
          area: string;
          customer_id: string;
          customer_name: string;
          last_out_at: string;
          outstanding: number;
          overdue: boolean;
        }[];
      };
      unused_meals_value: { Args: { p_customer: string }; Returns: Json };
      update_customer: { Args: { p_customer: string; p_patch: Json }; Returns: undefined };
      update_item: {
        Args: {
          p_active?: boolean;
          p_category?: Database['public']['Enums']['item_category'];
          p_item: string;
          p_min_qty?: number;
          p_name?: string;
        };
        Returns: undefined;
      };
      update_route: {
        Args: {
          p_active?: boolean;
          p_clear_rider?: boolean;
          p_name?: string;
          p_rider?: string;
          p_route: string;
        };
        Returns: undefined;
      };
      upsert_dish: {
        Args: {
          p_active?: boolean;
          p_dish?: string;
          p_kitchen: string;
          p_name: string;
          p_serves?: Database['public']['Enums']['diet_type'][];
        };
        Returns: string;
      };
      upsert_supplier: {
        Args: {
          p_kitchen: string;
          p_name: string;
          p_notes?: string;
          p_phone?: string;
          p_supplier?: string;
        };
        Returns: string;
      };
      wa_add_location_address: {
        Args: { p_conversation: string; p_label?: string; p_lat: number; p_lng: number };
        Returns: string;
      };
      wa_apply_change: {
        Args: {
          p_address?: string;
          p_conversation: string;
          p_dry_run?: boolean;
          p_from: string;
          p_slot?: Database['public']['Enums']['meal_slot'];
          p_subscription: string;
          p_to?: string;
          p_type: Database['public']['Enums']['change_type'];
        };
        Returns: Json;
      };
      wa_claim_outbox: {
        Args: { p_limit?: number };
        Returns: {
          attempts: number;
          conversation_id: string;
          id: string;
          in_window: boolean;
          kitchen_id: string;
          kitchen_name: string;
          language: Database['public']['Enums']['language_code'];
          opted_in: boolean;
          payload: Json;
          phone_e164: string;
          recipient_id: string;
          recipient_type: string;
          template: string;
        }[];
      };
      wa_complete_outbox: {
        Args: {
          p_error: string;
          p_id: string;
          p_ok: boolean;
          p_rendered: string;
          p_skip?: boolean;
          p_wa_message_id: string;
        };
        Returns: undefined;
      };
      wa_context: { Args: { p_conversation: string }; Returns: Json };
      wa_create_complaint: {
        Args: {
          p_category: string;
          p_conversation: string;
          p_description: string;
          p_photo_url?: string;
        };
        Returns: string;
      };
      wa_handoff: { Args: { p_conversation: string; p_reason: string }; Returns: undefined };
      wa_lead_choose: { Args: { p_kitchen: string; p_lead: string }; Returns: Json };
      wa_lead_get: {
        Args: {
          p_campaign?: string;
          p_name?: string;
          p_phone: string;
          p_source?: Database['public']['Enums']['lead_source'];
        };
        Returns: Json;
      };
      wa_lead_update: { Args: { p_fields: Json; p_lead: string; p_step?: string }; Returns: Json };
      wa_log_outbound: {
        Args: {
          p_body: string;
          p_conversation: string;
          p_handled_by: string;
          p_intent?: string;
          p_payload: Json;
          p_status: string;
          p_wa_message_id: string;
        };
        Returns: string;
      };
      wa_magic_link: { Args: { p_conversation: string }; Returns: string };
      wa_message_status: {
        Args: { p_status: string; p_wa_message_id: string };
        Returns: undefined;
      };
      wa_payment_link_record: { Args: { p_conversation: string; p_meals: number }; Returns: Json };
      wa_platform_conversation: { Args: { p_conversation: string }; Returns: Json };
      wa_receive: {
        Args: {
          p_body: string;
          p_contact_name?: string;
          p_from: string;
          p_kitchen_hint?: string;
          p_message_id: string;
          p_payload: Json;
        };
        Returns: Json;
      };
      wa_select_kitchen: { Args: { p_conversation: string; p_kitchen: string }; Returns: string };
      wa_update_conversation: {
        Args: {
          p_conversation: string;
          p_language?: Database['public']['Enums']['language_code'];
          p_opt_in?: boolean;
          p_state?: Json;
        };
        Returns: undefined;
      };
      wa_vendor_apply: {
        Args: {
          p_area: string;
          p_campaign?: string;
          p_kitchen_name: string;
          p_name: string;
          p_phone: string;
          p_subscribers: number;
        };
        Returns: string;
      };
    };
    Enums: {
      balance_entry_type: 'recharge' | 'meal' | 'credit' | 'refund' | 'adjust';
      change_channel: 'whatsapp' | 'web' | 'vendor' | 'rider';
      change_type: 'skip' | 'pause' | 'resume' | 'address' | 'cancel';
      customer_source: 'vendor' | 'import' | 'whatsapp' | 'web' | 'platform';
      diet_type: 'veg' | 'nonveg' | 'jain';
      fail_reason:
        | 'not_home'
        | 'wrong_address'
        | 'refused'
        | 'unreachable'
        | 'kitchen_late'
        | 'food_issue'
        | 'missing_meal'
        | 'rider_issue'
        | 'other';
      item_category:
        | 'grain'
        | 'pulse'
        | 'vegetable'
        | 'dairy'
        | 'meat'
        | 'spice'
        | 'oil'
        | 'gas'
        | 'packaging'
        | 'other';
      kitchen_status: 'draft' | 'active' | 'suspended';
      language_code: 'en' | 'or' | 'hi';
      lead_source:
        | 'whatsapp'
        | 'website'
        | 'google_ads'
        | 'instagram'
        | 'justdial'
        | 'call'
        | 'referral'
        | 'other';
      lead_status:
        | 'new'
        | 'qualifying'
        | 'qualified'
        | 'matched'
        | 'trial'
        | 'converted'
        | 'renewed'
        | 'waitlist'
        | 'lost';
      meal_slot: 'lunch' | 'dinner';
      member_role: 'owner' | 'staff' | 'rider';
      order_status:
        'scheduled' | 'locked' | 'prepared' | 'out' | 'delivered' | 'failed' | 'skipped';
      payment_method:
        'razorpay_link' | 'razorpay_autopay' | 'cash' | 'upi_manual' | 'bank_transfer';
      payment_status:
        'created' | 'pending' | 'paid' | 'failed' | 'expired' | 'cancelled' | 'review';
      proof_type: 'otp' | 'photo' | 'none';
      refund_method: 'razorpay' | 'cash' | 'upi_manual' | 'bank_transfer';
      refund_status: 'pending' | 'processing' | 'processed' | 'failed';
      run_status: 'planned' | 'out' | 'done';
      stock_move_type: 'purchase' | 'consume' | 'waste' | 'adjust' | 'count';
      stock_unit: 'kg' | 'g' | 'l' | 'ml' | 'pc';
      stop_status: 'pending' | 'delivered' | 'failed';
      subscription_status:
        'trial' | 'active' | 'paused' | 'low_balance' | 'suspended' | 'cancelled';
      vendor_app_status: 'new' | 'contacted' | 'onboarding' | 'live' | 'rejected';
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, 'public'>];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema['Tables'] & DefaultSchema['Views'])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Views'])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Views'])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema['Tables'] & DefaultSchema['Views'])
    ? (DefaultSchema['Tables'] & DefaultSchema['Views'])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema['Tables'] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables']
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema['Tables']
    ? DefaultSchema['Tables'][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema['Tables'] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables']
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema['Tables']
    ? DefaultSchema['Tables'][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    keyof DefaultSchema['Enums'] | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions['schema']]['Enums']
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions['schema']]['Enums'][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema['Enums']
    ? DefaultSchema['Enums'][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    keyof DefaultSchema['CompositeTypes'] | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions['schema']]['CompositeTypes']
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions['schema']]['CompositeTypes'][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema['CompositeTypes']
    ? DefaultSchema['CompositeTypes'][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  public: {
    Enums: {
      balance_entry_type: ['recharge', 'meal', 'credit', 'refund', 'adjust'],
      change_channel: ['whatsapp', 'web', 'vendor', 'rider'],
      change_type: ['skip', 'pause', 'resume', 'address', 'cancel'],
      customer_source: ['vendor', 'import', 'whatsapp', 'web', 'platform'],
      diet_type: ['veg', 'nonveg', 'jain'],
      fail_reason: [
        'not_home',
        'wrong_address',
        'refused',
        'unreachable',
        'kitchen_late',
        'food_issue',
        'missing_meal',
        'rider_issue',
        'other',
      ],
      item_category: [
        'grain',
        'pulse',
        'vegetable',
        'dairy',
        'meat',
        'spice',
        'oil',
        'gas',
        'packaging',
        'other',
      ],
      kitchen_status: ['draft', 'active', 'suspended'],
      language_code: ['en', 'or', 'hi'],
      lead_source: [
        'whatsapp',
        'website',
        'google_ads',
        'instagram',
        'justdial',
        'call',
        'referral',
        'other',
      ],
      lead_status: [
        'new',
        'qualifying',
        'qualified',
        'matched',
        'trial',
        'converted',
        'renewed',
        'waitlist',
        'lost',
      ],
      meal_slot: ['lunch', 'dinner'],
      member_role: ['owner', 'staff', 'rider'],
      order_status: ['scheduled', 'locked', 'prepared', 'out', 'delivered', 'failed', 'skipped'],
      payment_method: ['razorpay_link', 'razorpay_autopay', 'cash', 'upi_manual', 'bank_transfer'],
      payment_status: ['created', 'pending', 'paid', 'failed', 'expired', 'cancelled', 'review'],
      proof_type: ['otp', 'photo', 'none'],
      refund_method: ['razorpay', 'cash', 'upi_manual', 'bank_transfer'],
      refund_status: ['pending', 'processing', 'processed', 'failed'],
      run_status: ['planned', 'out', 'done'],
      stock_move_type: ['purchase', 'consume', 'waste', 'adjust', 'count'],
      stock_unit: ['kg', 'g', 'l', 'ml', 'pc'],
      stop_status: ['pending', 'delivered', 'failed'],
      subscription_status: ['trial', 'active', 'paused', 'low_balance', 'suspended', 'cancelled'],
      vendor_app_status: ['new', 'contacted', 'onboarding', 'live', 'rejected'],
    },
  },
} as const;
