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
      kitchen_settings: {
        Row: {
          credit_limit_meals: number;
          grace_days: number;
          kitchen_id: string;
          low_balance_meals: number;
          notice_days: number;
          phone_pause_close_time: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          credit_limit_meals?: number;
          grace_days?: number;
          kitchen_id: string;
          low_balance_meals?: number;
          notice_days?: number;
          phone_pause_close_time?: string;
          updated_at?: string;
        };
        Update: {
          credit_limit_meals?: number;
          grace_days?: number;
          kitchen_id?: string;
          low_balance_meals?: number;
          notice_days?: number;
          phone_pause_close_time?: string;
          updated_at?: string;
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
          address: string | null;
          area: string | null;
          capacity_dinner: number;
          capacity_lunch: number;
          city: string;
          created_at: string;
          cutoff_dinner: string;
          cutoff_dinner_prev_day: boolean;
          cutoff_lunch: string;
          cutoff_lunch_prev_day: boolean;
          fssai_no: string | null;
          geo_point: unknown;
          id: string;
          lat: number | null;
          lng: number | null;
          name: string;
          owner_id: string;
          service_radius_km: number;
          slug: string;
          status: Database['public']['Enums']['kitchen_status'];
          updated_at: string;
          weekly_off: number[];
        };
        ComputedFields: never;
        Insert: {
          address?: string | null;
          area?: string | null;
          capacity_dinner?: number;
          capacity_lunch?: number;
          city?: string;
          created_at?: string;
          cutoff_dinner?: string;
          cutoff_dinner_prev_day?: boolean;
          cutoff_lunch?: string;
          cutoff_lunch_prev_day?: boolean;
          fssai_no?: string | null;
          geo_point?: never;
          id?: string;
          lat?: number | null;
          lng?: number | null;
          name: string;
          owner_id: string;
          service_radius_km?: number;
          slug: string;
          status?: Database['public']['Enums']['kitchen_status'];
          updated_at?: string;
          weekly_off?: number[];
        };
        Update: {
          address?: string | null;
          area?: string | null;
          capacity_dinner?: number;
          capacity_lunch?: number;
          city?: string;
          created_at?: string;
          cutoff_dinner?: string;
          cutoff_dinner_prev_day?: boolean;
          cutoff_lunch?: string;
          cutoff_lunch_prev_day?: boolean;
          fssai_no?: string | null;
          geo_point?: never;
          id?: string;
          lat?: number | null;
          lng?: number | null;
          name?: string;
          owner_id?: string;
          service_radius_km?: number;
          slug?: string;
          status?: Database['public']['Enums']['kitchen_status'];
          updated_at?: string;
          weekly_off?: number[];
        };
        Relationships: [];
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
    };
    Views: {
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
      claim_invites: { Args: Record<PropertyKey, never>; Returns: number };
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
          address: string | null;
          area: string | null;
          capacity_dinner: number;
          capacity_lunch: number;
          city: string;
          created_at: string;
          cutoff_dinner: string;
          cutoff_dinner_prev_day: boolean;
          cutoff_lunch: string;
          cutoff_lunch_prev_day: boolean;
          fssai_no: string | null;
          geo_point: unknown;
          id: string;
          lat: number | null;
          lng: number | null;
          name: string;
          owner_id: string;
          service_radius_km: number;
          slug: string;
          status: Database['public']['Enums']['kitchen_status'];
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
      customer_phone: { Args: { p_customer: string }; Returns: string };
      erase_customer: { Args: { p_customer: string }; Returns: undefined };
      import_customers: {
        Args: { p_consent: boolean; p_file_name?: string; p_kitchen: string; p_rows: Json };
        Returns: Json;
      };
      invite_member: {
        Args: {
          p_display_name?: string;
          p_kitchen: string;
          p_phone: string;
          p_role: Database['public']['Enums']['member_role'];
        };
        Returns: Json;
      };
      remove_member: { Args: { p_member: string }; Returns: undefined };
      reveal_customer_phone: { Args: { p_customer: string }; Returns: string };
      revoke_invite: { Args: { p_invite: string }; Returns: undefined };
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
      set_kitchen_status: {
        Args: { p_kitchen: string; p_status: Database['public']['Enums']['kitchen_status'] };
        Returns: undefined;
      };
      set_member_role: {
        Args: { p_member: string; p_role: Database['public']['Enums']['member_role'] };
        Returns: undefined;
      };
      update_customer: { Args: { p_customer: string; p_patch: Json }; Returns: undefined };
    };
    Enums: {
      customer_source: 'vendor' | 'import' | 'whatsapp' | 'web' | 'platform';
      diet_type: 'veg' | 'nonveg' | 'jain';
      kitchen_status: 'draft' | 'active' | 'suspended';
      language_code: 'en' | 'or' | 'hi';
      meal_slot: 'lunch' | 'dinner';
      member_role: 'owner' | 'staff' | 'rider';
      subscription_status:
        'trial' | 'active' | 'paused' | 'low_balance' | 'suspended' | 'cancelled';
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
      customer_source: ['vendor', 'import', 'whatsapp', 'web', 'platform'],
      diet_type: ['veg', 'nonveg', 'jain'],
      kitchen_status: ['draft', 'active', 'suspended'],
      language_code: ['en', 'or', 'hi'],
      meal_slot: ['lunch', 'dinner'],
      member_role: ['owner', 'staff', 'rider'],
      subscription_status: ['trial', 'active', 'paused', 'low_balance', 'suspended', 'cancelled'],
    },
  },
} as const;
