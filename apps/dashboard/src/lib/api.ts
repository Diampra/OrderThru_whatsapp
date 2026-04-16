import axios from 'axios';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:4000';

export const api = axios.create({
  baseURL: API_BASE_URL,
});

api.interceptors.request.use((config) => {
  const token = window.localStorage.getItem('restaurant_admin_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

export type DashboardSummary = {
  ordersCount: number;
  pendingOrdersCount: number;
  completedOrdersCount: number;
  reviewsCount: number;
  averageRating: number;
  productCount: number;
};

export type Role = 'SUPER_ADMIN' | 'TENANT_ADMIN';

export type ProductSchemaItem = {
  id?: string;
  name: string;
  label?: string;
  type: 'string' | 'number' | 'boolean' | 'select' | 'text';
  required?: boolean;
  displayInList?: boolean;
  options?: string[];
  icon?: string;          
  appliesTo?: string[];   // Specific categories this field applies to. Empty = all.
};

export type Tenant = {
  id: string;
  name: string;
  businessType?: string;
  productSchema: ProductSchemaItem[] | null;
  categories: string[] | null;
  isBotEnabled: boolean;
  whatsappPhoneNumberId?: string;
  whatsappAccessToken?: string;
  whatsappVerifyToken?: string;
  whatsappApiVersion?: string;
  razorpayKeyId?: string;
  razorpayKeySecret?: string;
  openTime?: string;
  closeTime?: string;
  timezone?: string;
  taxRate?: string | number;
  messageTemplates?: Record<string, string>;
  _count?: {
    products: number;
    admins: number;
  };
};

export type Product = {
  id: string;
  name: string;
  description: string;
  price: string;
  category: string;
  imageUrl?: string;
  tags?: string[];
  isAvailable: boolean;
  isVeg: boolean;
  taxRate: string;
  attributes: Record<string, any> | null;
};

export type Review = {
  id: string;
  rating: number;
  comment: string;
  createdAt: string;
  product: {
    id: string;
    name: string;
  };
  order: {
    id: string;
    customerPhone: string;
  };
};

export type Order = {
  id: string;
  customerPhone: string;
  totalAmount: string;
  status: 'PENDING' | 'PREPARING' | 'READY' | 'COMPLETED';
  source: 'BOT' | 'MANUAL';
  createdAt: string;
  paymentLinkUrl: string | null;
  orderItems: Array<{
    id: string;
    quantity: number;
    product: {
      id: string;
      name: string;
    };
  }>;
  reviews: Array<{
    id: string;
    rating: number;
  }>;
};

export type StaffAlert = {
  id: string;
  tenantId: string;
  customerPhone: string;
  reason: string;
  isDismissed: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ChatMessage = {
  id: string;
  customerPhone: string;
  sender: 'USER' | 'BOT' | 'STAFF' | 'SYSTEM';
  content: string;
  createdAt: string;
};

export type Conversation = {
  customerPhone: string;
  lastMessage: string;
  lastMessageAt: string;
  lastMessageSender: 'USER' | 'BOT' | 'STAFF';
  unresolvedAlertCount: number;
};

export type SalesAnalytics = {
  date: string;
  sales: number;
};

export type Sticker = {
  id: string;
  name: string;
  category: string;
  fileUrl: string;
  tags: string[];
  createdAt: string;
};
