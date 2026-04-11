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
  menuCount: number;
};

export type MenuItem = {
  id: string;
  name: string;
  description: string;
  price: string;
  isAvailable: boolean;
};

export type Review = {
  id: string;
  rating: number;
  comment: string;
  createdAt: string;
  item: {
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
  createdAt: string;
  paymentLinkUrl: string | null;
  orderItems: Array<{
    id: string;
    quantity: number;
    item: {
      id: string;
      name: string;
    };
  }>;
  reviews: Array<{
    id: string;
    rating: number;
  }>;
};
