import { useState, useMemo, useEffect, Fragment, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { io } from 'socket.io-client';
import { api, type DashboardSummary, type Product, type Order, type Review, type Role, type Tenant, type ProductSchemaItem, type StaffAlert, type ChatMessage, type Conversation } from './lib/api';

const statusOptions = ['PENDING', 'PREPARING', 'READY', 'COMPLETED'] as const;

function formatPrice(value: string | number) {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
  }).format(Number(value));
}

type LoginResponse = {
  accessToken: string;
  user: {
    id: string;
    email: string;
    role: Role;
    tenantId: string | null;
  };
};

type ProductFormState = {
  name: string;
  description: string;
  price: string;
  category: string;
  isVeg: boolean;
  taxRate: string;
  imageUrl: string;
  tags_raw: string;
  isAvailable: boolean;
  attributes: Record<string, any>;
};

const emptyProductForm: ProductFormState = {
  name: '',
  description: '',
  price: '',
  category: 'General',
  isVeg: true,
  taxRate: '5',
  imageUrl: '',
  tags_raw: '',
  isAvailable: true,
  attributes: {},
};

export default function App() {
  const queryClient = useQueryClient();
  const [credentials, setCredentials] = useState({
    email: '',
    password: '',
  });
  const [productForm, setProductForm] = useState<ProductFormState>(emptyProductForm);
  const [editingProductId, setEditingProductId] = useState<string | null>(null);
  const [editingTenant, setEditingTenant] = useState<Tenant | null>(null);
  const [activeTab, setActiveTab]= useState<'dashboard' | 'pos' | 'settings'>('dashboard');
  const [localSchema, setLocalSchema] = useState<ProductSchemaItem[]>([]);
  
  const token = window.localStorage.getItem('restaurant_admin_token');
  const userStr = window.localStorage.getItem('restaurant_admin_user');
  const currentUser = useMemo(() => userStr ? JSON.parse(userStr) as LoginResponse['user'] : null, [userStr]);

  const [recentOrders, setRecentOrders] = useState<Set<string>>(new Set());
  const [now, setNow] = useState(new Date());

  // Reply state
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [replyMessage, setReplyMessage] = useState('');

  // Chat conversation state
  const [selectedPhone, setSelectedPhone] = useState<string | null>(null);
  const [chatInput, setChatInput] = useState('');
  const chatBottomRef = useRef<HTMLDivElement>(null);

  // POS / Manual Order state
  type PosItem = {
    productId: string;
    quantity: number;
    taxEnabled: boolean;
    taxRate: number; // 0.05 = 5%
  };
  const [isManualModalOpen, setIsManualModalOpen] = useState(false);
  const [manualPhone, setManualPhone] = useState('');
  const [manualItems, setManualItems] = useState<{productId: string, quantity: number, taxRate?: number}[]>([]);
  
  const [posItems, setPosItems] = useState<PosItem[]>([]);
  const [posPhone, setPosPhone] = useState('');
  const [posSearch, setPosSearch] = useState('');
  const [posDiscount, setPosDiscount] = useState<string>(''); // Flat amount string
  const [posNotes, setPosNotes] = useState('');
  const [posPaymentMethod, setPosPaymentMethod] = useState<'COD' | 'ONLINE'>('COD');

  // Toast state
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  const showToast = (message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  };

  // Force re-render every minute for delayed status updates
  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (editingTenant) {
      setLocalSchema(editingTenant.productSchema || []);
    } else {
      setLocalSchema([]);
    }
  }, [editingTenant]);

  const addField = () => {
    setLocalSchema(prev => [
      ...prev,
      { name: `field_${Date.now()}`, label: 'New Field', type: 'text', required: false }
    ]);
  };

  const updateField = (index: number, updates: Partial<ProductSchemaItem>) => {
    setLocalSchema(prev => {
      const next = [...prev];
      next[index] = { ...next[index], ...updates };
      return next;
    });
  };

  const removeField = (index: number) => {
    setLocalSchema(prev => prev.filter((_, i) => i !== index));
  };

  const maskId = (id: string) => `#${id.slice(-7).toUpperCase()}`;

  const getOrderStatusStyles = (order: Order) => {
    if (recentOrders.has(order.id)) {
      return 'bg-emerald-50 ring-2 ring-emerald-500 ring-inset';
    }
    
    if (order.status === 'PENDING') {
      const created = new Date(order.createdAt);
      const diffMins = (now.getTime() - created.getTime()) / 60000;
      
      if (diffMins > 10) return 'bg-rose-50 ring-1 ring-rose-200';
      if (diffMins > 5) return 'bg-amber-50 ring-1 ring-amber-200';
    }
    
    return '';
  };

  // Real-time synchronization
  useEffect(() => {
    if (token && currentUser?.tenantId && currentUser.role === 'TENANT_ADMIN') {
      const socket = io(import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000', {
        transports: ['websocket'],
      });

      socket.on('connect', () => {
        socket.emit('joinTenant', currentUser.tenantId);
      });

      socket.on('staff.notification', () => {
        const audio = new Audio('https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3');
        audio.play().catch(e => console.error('Audio playback failed:', e));
        // Refresh conversations from DB
        queryClient.invalidateQueries({ queryKey: ['conversations'] });
        queryClient.invalidateQueries({ queryKey: ['staff-alerts'] });
        if (selectedPhone) {
          queryClient.invalidateQueries({ queryKey: ['chat-history', selectedPhone] });
        }
      });

      socket.on('message.received', (data: { customerPhone: string, sender: string, content: string }) => {
        // Play notification sound only for incoming customer messages
        if (data.sender === 'USER') {
          const audio = new Audio('https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3');
          audio.play().catch(e => console.error('Audio playback failed:', e));
        }
        
        // Refresh conversations and history
        queryClient.invalidateQueries({ queryKey: ['conversations'] });
        if (selectedPhone === data.customerPhone) {
          queryClient.invalidateQueries({ queryKey: ['chat-history', data.customerPhone] });
        }
      });

      socket.on('order.created', (order: Order) => {
        // Play notification sound
        const audio = new Audio('https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3');
        audio.play().catch(e => console.error('Audio playback failed:', e));
        
        // Highlight logic
        setRecentOrders(prev => {
          const next = new Set(prev);
          next.add(order.id);
          return next;
        });

        // Remove highlight after 30 seconds
        setTimeout(() => {
          setRecentOrders(prev => {
            const next = new Set(prev);
            next.delete(order.id);
            return next;
          });
        }, 30000);

        // Refresh data
        queryClient.invalidateQueries({ queryKey: ['orders'] });
        queryClient.invalidateQueries({ queryKey: ['summary'] });
      });

      return () => {
        socket.disconnect();
      };
    }
  }, [token, currentUser?.tenantId, currentUser?.role, queryClient]);

  const loginMutation = useMutation({
    mutationFn: async () => {
      const response = await api.post<LoginResponse>('/auth/login', credentials);
      return response.data;
    },
    onSuccess: (data) => {
      window.localStorage.setItem('restaurant_admin_token', data.accessToken);
      window.localStorage.setItem('restaurant_admin_user', JSON.stringify(data.user));
      queryClient.invalidateQueries();
      window.location.reload();
    },
  });

  const summaryQuery = useQuery({
    queryKey: ['summary'],
    queryFn: async () => (await api.get<DashboardSummary>('/dashboard/summary')).data,
    enabled: Boolean(token) && currentUser?.role === 'TENANT_ADMIN',
  });

  const ordersQuery = useQuery({
    queryKey: ['orders'],
    queryFn: async () => (await api.get<Order[]>('/orders')).data,
    enabled: Boolean(token) && currentUser?.role === 'TENANT_ADMIN',
  });

  const productsQuery = useQuery({
    queryKey: ['products'],
    queryFn: async () => (await api.get<Product[]>('/product/admin/all')).data,
    enabled: Boolean(token) && currentUser?.role === 'TENANT_ADMIN',
  });

  const productQuery = useQuery({
    queryKey: ['products-admin'],
    queryFn: async () => (await api.get<Product[]>('/product/admin/all')).data,
    enabled: Boolean(token) && currentUser?.role === 'TENANT_ADMIN',
  });

  const tenantQuery = useQuery({
    queryKey: ['current-tenant'],
    queryFn: async () => (await api.get<Tenant>(`/tenants/admin/me`)).data,
    enabled: Boolean(token) && currentUser?.role === 'TENANT_ADMIN',
  });

  const allTenantsQuery = useQuery({
    queryKey: ['all-tenants'],
    queryFn: async () => (await api.get<Tenant[]>('/tenants')).data,
    enabled: Boolean(token) && currentUser?.role === 'SUPER_ADMIN',
  });

  const reviewsQuery = useQuery({
    queryKey: ['reviews'],
    queryFn: async () => (await api.get<Review[]>('/reviews')).data,
    enabled: Boolean(token) && currentUser?.role === 'TENANT_ADMIN',
  });

  const alertsQuery = useQuery({
    queryKey: ['staff-alerts'],
    queryFn: async () => (await api.get<StaffAlert[]>('/dashboard/alerts')).data,
    enabled: Boolean(token) && currentUser?.role === 'TENANT_ADMIN',
  });

  const conversationsQuery = useQuery({
    queryKey: ['conversations'],
    queryFn: async () => (await api.get<Conversation[]>('/dashboard/conversations')).data,
    enabled: Boolean(token) && currentUser?.role === 'TENANT_ADMIN',
    refetchInterval: 15000,
  });

  const chatHistoryQuery = useQuery({
    queryKey: ['chat-history', selectedPhone],
    queryFn: async () => (await api.get<ChatMessage[]>(`/dashboard/conversations/${selectedPhone}`)).data,
    enabled: Boolean(token) && Boolean(selectedPhone),
    refetchInterval: 5000,
  });

  const dismissAlertMutation = useMutation({
    mutationFn: async (alertId: string) =>
      api.patch(`/dashboard/alerts/${alertId}/dismiss`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['staff-alerts'] });
    },
  });

  const replyMutation = useMutation({
    mutationFn: async ({ customerPhone, message }: { customerPhone: string; message: string }) =>
      api.post('/dashboard/reply', { customerPhone, message }),
    onSuccess: () => {
      setReplyingTo(null);
      setReplyMessage('');
      showToast('Reply sent successfully! 🚀');
    },
    onError: (err: any) => {
      console.error('Reply failed:', err);
      showToast('Failed to send reply. Please try again.', 'error');
    }
  });

  const chatSendMutation = useMutation({
    mutationFn: async ({ customerPhone, message }: { customerPhone: string; message: string }) =>
      api.post('/dashboard/reply', { customerPhone, message }),
    onSuccess: () => {
      setChatInput('');
      queryClient.invalidateQueries({ queryKey: ['chat-history', selectedPhone] });
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
    },
    onError: () => showToast('Failed to send message.', 'error'),
  });

  const resolveConversationMutation = useMutation({
    mutationFn: async (phone: string) =>
      api.post(`/dashboard/conversations/${phone}/resolve`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
      showToast('Conversation resolved ✅');
    },
  });

  // Auto-scroll chat to bottom when new messages arrive or conversation is selected
  useEffect(() => {
    if (chatBottomRef.current) {
      chatBottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [chatHistoryQuery.data, selectedPhone]);

  const manualOrderMutation = useMutation({
    mutationFn: async ({ customerPhone, items, discount, notes }: { customerPhone: string; items: any[]; discount?: number; notes?: string }) =>
      api.post('/dashboard/manual-order', { customerPhone, items, discount, notes }),
    onSuccess: () => {
      setIsManualModalOpen(false);
      setManualPhone('');
      setManualItems([]);
      
      setPosItems([]);
      setPosPhone('');
      setPosDiscount('');
      setPosNotes('');
      
      showToast('Order placed successfully! 🛒');
      queryClient.invalidateQueries({ queryKey: ['orders'] });
      queryClient.invalidateQueries({ queryKey: ['summary'] });
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
    },
    onError: (err: any) => {
      alert('Failed to place manual order: ' + (err.response?.data?.message || err.message));
    }
  });

  const statusMutation = useMutation({
    mutationFn: async ({ orderId, status }: { orderId: string; status: string }) =>
      api.patch(`/orders/${orderId}/status`, { status }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['orders'] });
      queryClient.invalidateQueries({ queryKey: ['summary'] });
    },
  });

  const productMutation = useMutation({
    mutationFn: async () => {
      const { name, description, price, category, isVeg, taxRate, imageUrl, attributes } = productForm;
      const payload = {
        name,
        description,
        price: Number(price),
        category,
        isVeg,
        taxRate: Number(taxRate) / 100, // Convert e.g. 5 to 0.05
        imageUrl,
        attributes,
        tags: productForm.tags_raw.split(',').map(t => t.trim()).filter(Boolean),
      };

      if (editingProductId) {
        await api.patch(`/product/${editingProductId}`, payload);
      } else {
        await api.post('/product', payload);
      }
    },
    onSuccess: () => {
      setProductForm(emptyProductForm);
      setEditingProductId(null);
      queryClient.invalidateQueries({ queryKey: ['products-admin'] });
      queryClient.invalidateQueries({ queryKey: ['summary'] });
    },
    onError: (error: any) => {
      alert(`Error saving product: ${error.response?.data?.message || error.message}`);
    },
  });

  const deleteProductMutation = useMutation({
    mutationFn: async (id: string) => api.delete(`/product/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['products-admin'] });
      queryClient.invalidateQueries({ queryKey: ['summary'] });
    },
  });

  const updateTenantMutation = useMutation({
    mutationFn: async (tenant: Partial<Tenant>) => {
      const { id, ...data } = tenant;
      await api.patch(`/tenants/${id}`, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['all-tenants'] });
      queryClient.invalidateQueries({ queryKey: ['current-tenant'] });
      setEditingTenant(null);
      showToast('Settings saved successfully!');
    },
    onError: (error: any) => {
      showToast(`Error saving settings: ${error.response?.data?.message || error.message}`, 'error');
    },
  });

  if (!token) {
    return (
      <main className="flex min-h-screen items-center justify-center px-4 py-12">
        <section className="w-full max-w-5xl overflow-hidden rounded-[2rem] bg-white shadow-panel md:grid md:grid-cols-[1.2fr_0.8fr]">
          <div className="bg-ink px-8 py-10 text-white md:px-12 md:py-14">
            <p className="text-sm uppercase tracking-[0.3em] text-red-200">Global Ops Platform</p>
            <h1 className="mt-6 max-w-md font-display text-5xl leading-tight">
              Generic Multi-Tenant Infrastructure.
            </h1>
            <p className="mt-6 max-w-md text-base text-white/75">
              Support any business structure—from gourmet restaurants to luxury apparel—all within a unified WhatsApp automation core.
            </p>
          </div>
          <div className="px-8 py-10 md:px-10 md:py-14">
            <h2 className="font-display text-3xl text-ink">Admin Login</h2>
            <form
              className="mt-8 space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                loginMutation.mutate();
              }}
            >
              <label className="block">
                <span className="mb-2 block text-sm text-slate-600">Email</span>
                <input
                  className="w-full rounded-2xl border border-slate-200 px-4 py-3 outline-none transition focus:border-ember"
                  type="email"
                  value={credentials.email}
                  onChange={(event) =>
                    setCredentials((current) => ({ ...current, email: event.target.value }))
                  }
                />
              </label>
              <label className="block">
                <span className="mb-2 block text-sm text-slate-600">Password</span>
                <input
                  className="w-full rounded-2xl border border-slate-200 px-4 py-3 outline-none transition focus:border-ember"
                  type="password"
                  value={credentials.password}
                  onChange={(event) =>
                    setCredentials((current) => ({ ...current, password: event.target.value }))
                  }
                />
              </label>
              <button
                className="w-full rounded-2xl bg-ember px-4 py-3 font-medium text-white transition hover:bg-red-600"
                type="submit"
                disabled={loginMutation.isPending}
              >
                {loginMutation.isPending ? 'Signing in...' : 'Sign in'}
              </button>
              {loginMutation.isError ? (
                <p className="text-sm text-red-600">Login failed. Check your credentials.</p>
              ) : null}
            </form>
          </div>
        </section>
      </main>
    );
  }

  if (currentUser?.role === 'SUPER_ADMIN') {
    return (
      <main className="min-h-screen px-4 py-6 md:px-8">
        <div className="mx-auto max-w-7xl">
          <header className="rounded-[2rem] bg-indigo-950 px-6 py-8 text-white shadow-panel md:px-8">
            <div className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
              <div>
                <p className="text-sm uppercase tracking-[0.3em] text-indigo-200">System Control</p>
                <h1 className="mt-4 font-display text-4xl">Super Admin Dashboard</h1>
                <p className="mt-3 max-w-2xl text-white/70">Design the core data structure for every tenant in the network.</p>
              </div>
              <button
                className="rounded-full border border-white/20 px-5 py-3 text-sm text-white/80 transition hover:bg-white/10"
                onClick={() => {
                  window.localStorage.clear();
                  window.location.reload();
                }}
              >
                Logout
              </button>
            </div>
          </header>

          <section className="mt-6 grid gap-6">
            <article className="rounded-[2rem] bg-white p-6 shadow-panel">
              <h2 className="font-display text-3xl text-ink">Active Tenants</h2>
              <div className="mt-6 space-y-4">
                {allTenantsQuery.data?.map(tenant => (
                  <div key={tenant.id} className="rounded-3xl border border-slate-100 p-6 flex flex-col gap-4">
                    <div className="flex justify-between items-start">
                      <div>
                        <h3 className="font-display text-xl">{tenant.name}</h3>
                        <p className="text-sm text-slate-500">ID: {tenant.id} | {tenant._count?.products} Products</p>
                      </div>
                      <div className="flex gap-2">
                         <button 
                          className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-sm transition-colors" 
                          onClick={() => setEditingTenant(tenant)}
                        >
                           Manage Settings
                         </button>
                      </div>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="text-xs space-y-1">
                        <p className="font-semibold text-slate-400 uppercase tracking-wider">WhatsApp Status</p>
                        <p className={tenant.whatsappAccessToken ? 'text-green-600' : 'text-amber-600'}>
                          {tenant.whatsappAccessToken ? '✓ Connected' : '⚠ Missing Credentials'}
                        </p>
                      </div>
                      <div className="text-xs space-y-1">
                        <p className="font-semibold text-slate-400 uppercase tracking-wider">Payment Status</p>
                        <p className={tenant.razorpayKeyId ? 'text-indigo-600' : 'text-slate-400'}>
                          {tenant.razorpayKeyId ? '✓ Razorpay Enabled' : 'Cash on Delivery'}
                        </p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </article>
          </section>

          {/* Tenant Settings Modal */}
          {editingTenant && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-indigo-950/40 backdrop-blur-sm p-4">
              <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto bg-white rounded-[2.5rem] shadow-2xl p-8 scrollbar-hide">
                <div className="flex justify-between items-start mb-8">
                  <div>
                    <h2 className="font-display text-3xl text-ink">Manage {editingTenant.name}</h2>
                    <p className="text-sm text-slate-500 mt-1">Configure automation and payment infrastructure.</p>
                  </div>
                  <button 
                    onClick={() => setEditingTenant(null)}
                    className="p-2 hover:bg-slate-100 rounded-full transition-colors"
                  >
                    ×
                  </button>
                </div>

                <form className="space-y-8" onSubmit={(e) => {
                  e.preventDefault();
                  const formData = new FormData(e.currentTarget);
                  const updates: any = {
                    id: editingTenant.id,
                    name: formData.get('name'),
                    businessType: formData.get('businessType'),
                    whatsappVerifyToken: formData.get('whatsappVerifyToken'),
                    whatsappPhoneNumberId: formData.get('whatsappPhoneNumberId'),
                    whatsappAccessToken: formData.get('whatsappAccessToken'),
                    whatsappApiVersion: formData.get('whatsappApiVersion'),
                    razorpayKeyId: formData.get('razorpayKeyId'),
                    razorpayKeySecret: formData.get('razorpayKeySecret'),
                    timezone: formData.get('timezone'),
                    categories: (formData.get('categories_raw') as string)?.split(',').map(s => s.trim()).filter(Boolean) || [],
                  };
                  
                  updates.productSchema = localSchema;

                  updateTenantMutation.mutate(updates);
                }}>
                  <div className="space-y-6">
                    <div className="p-6 bg-slate-50 rounded-3xl space-y-4">
                      <h3 className="text-sm font-bold uppercase tracking-widest text-slate-400">Basic Information</h3>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <label className="block">
                          <span className="text-xs font-medium text-slate-600 mb-1 block">Business Name</span>
                          <input 
                            name="name"
                            defaultValue={editingTenant.name} 
                            placeholder="e.g. Gourmet Bistro"
                            className="w-full px-4 py-2 bg-white border border-slate-200 rounded-xl text-sm outline-none focus:border-indigo-500"
                          />
                        </label>
                        <label className="block">
                          <span className="text-xs font-medium text-slate-600 mb-1 block">Business Type</span>
                          <input 
                            name="businessType"
                            defaultValue={editingTenant.businessType || ''} 
                            placeholder="e.g. RESTAURANT"
                            className="w-full px-4 py-2 bg-white border border-slate-200 rounded-xl text-sm outline-none focus:border-indigo-500"
                          />
                        </label>
                      </div>
                    </div>

                    <div className="p-6 bg-slate-50 rounded-3xl space-y-4">
                      <h3 className="text-sm font-bold uppercase tracking-widest text-slate-400">WhatsApp Credentials</h3>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <label className="block">
                          <span className="text-xs font-medium text-slate-600 mb-1 block">Verify Token</span>
                          <input 
                            name="whatsappVerifyToken"
                            defaultValue={editingTenant.whatsappVerifyToken} 
                            placeholder="e.g. my_secret_verify_token"
                            className="w-full px-4 py-2 bg-white border border-slate-200 rounded-xl text-sm outline-none focus:border-indigo-500"
                          />
                        </label>
                        <label className="block">
                          <span className="text-xs font-medium text-slate-600 mb-1 block">Phone Number ID</span>
                          <input 
                            name="whatsappPhoneNumberId"
                            defaultValue={editingTenant.whatsappPhoneNumberId} 
                            placeholder="e.g. 10741392..."
                            className="w-full px-4 py-2 bg-white border border-slate-200 rounded-xl text-sm outline-none focus:border-indigo-500"
                          />
                        </label>
                        <label className="block col-span-full">
                          <span className="text-xs font-medium text-slate-600 mb-1 block">Access Token</span>
                          <textarea 
                            name="whatsappAccessToken"
                            defaultValue={editingTenant.whatsappAccessToken} 
                            rows={3}
                            placeholder="Long-lived page access token..."
                            className="w-full px-4 py-2 bg-white border border-slate-200 rounded-xl text-sm outline-none focus:border-indigo-500 resize-none font-mono"
                          />
                        </label>
                        <label className="block">
                          <span className="text-xs font-medium text-slate-600 mb-1 block">API Version</span>
                          <input 
                            name="whatsappApiVersion"
                            defaultValue={editingTenant.whatsappApiVersion || 'v20.0'} 
                            placeholder="v20.0"
                            className="w-full px-4 py-2 bg-white border border-slate-200 rounded-xl text-sm outline-none focus:border-indigo-500"
                          />
                        </label>
                      </div>
                    </div>

                    <div className="p-6 bg-slate-50 rounded-3xl space-y-4">
                      <h3 className="text-sm font-bold uppercase tracking-widest text-slate-400">Menu Categories</h3>
                      <label className="block">
                        <span className="text-xs font-medium text-slate-600 mb-1 block">Categories (comma-separated)</span>
                        <input 
                          name="categories_raw"
                          defaultValue={editingTenant.categories?.join(', ') || ''} 
                          placeholder="e.g. Starters, Main Course, Drinks"
                          className="w-full px-4 py-2 bg-white border border-slate-200 rounded-xl text-sm outline-none focus:border-indigo-500"
                        />
                      </label>
                    </div>

                    <div className="p-6 bg-slate-50 rounded-3xl space-y-4">
                      <h3 className="text-sm font-bold uppercase tracking-widest text-slate-400">Razorpay Configuration</h3>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <label className="block">
                          <span className="text-xs font-medium text-slate-600 mb-1 block">Key ID</span>
                          <input 
                            name="razorpayKeyId"
                            defaultValue={editingTenant.razorpayKeyId} 
                            placeholder="rzp_test_..."
                            className="w-full px-4 py-2 bg-white border border-slate-200 rounded-xl text-sm outline-none focus:border-indigo-500"
                          />
                        </label>
                        <label className="block">
                          <span className="text-xs font-medium text-slate-600 mb-1 block">Key Secret</span>
                          <input 
                            name="razorpayKeySecret"
                            defaultValue={editingTenant.razorpayKeySecret} 
                            type="password"
                            placeholder="••••••••"
                            className="w-full px-4 py-2 bg-white border border-slate-200 rounded-xl text-sm outline-none focus:border-indigo-500"
                          />
                        </label>
                      </div>
                    </div>

                    <div className="p-6 bg-slate-50 rounded-3xl space-y-4">
                      <div className="flex justify-between items-center">
                        <h3 className="text-sm font-bold uppercase tracking-widest text-slate-400">Product Custom Fields</h3>
                        <button 
                          type="button"
                          onClick={addField}
                          className="px-4 py-2 bg-indigo-100 text-indigo-700 rounded-xl text-xs font-bold hover:bg-indigo-200 transition-colors"
                        >
                          + Add Field
                        </button>
                      </div>

                      <div className="space-y-4">
                        {localSchema.map((item, index) => (
                          <div key={index} className="bg-white p-4 rounded-2xl border border-slate-100 shadow-sm relative group">
                            <button 
                              type="button" 
                              onClick={() => removeField(index)}
                              className="absolute -top-2 -right-2 bg-red-100 text-red-600 rounded-full w-6 h-6 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow-sm z-10"
                            >
                              ×
                            </button>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
                              <label>
                                <span className="text-[10px] font-bold text-slate-400 uppercase ml-1">Label (e.g. Size)</span>
                                <input 
                                  value={item.label || ''} 
                                  onChange={e => {
                                    const newLabel = e.target.value;
                                    const updates: Partial<ProductSchemaItem> = { label: newLabel };
                                    if (!item.name || item.name.startsWith('field_')) {
                                      updates.name = newLabel.toLowerCase().replace(/\s+/g, '_');
                                    }
                                    updateField(index, updates);
                                  }}
                                  className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-sm outline-none focus:border-indigo-400"
                                />
                              </label>
                              <label>
                                <span className="text-[10px] font-bold text-slate-400 uppercase ml-1">Type</span>
                                <select 
                                  value={item.type} 
                                  onChange={e => updateField(index, { type: e.target.value as any })}
                                  className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-sm outline-none focus:border-indigo-400"
                                >
                                  <option value="text">Short Text</option>
                                  <option value="string">Long Text</option>
                                  <option value="number">Number</option>
                                  <option value="boolean">Checkbox / Toggle</option>
                                  <option value="select">Dropdown / Options</option>
                                </select>
                              </label>
                              <label>
                                <span className="text-[10px] font-bold text-slate-400 uppercase ml-1">Icon (Emoji/Short Text)</span>
                                <input 
                                  value={item.icon || ''} 
                                  placeholder="e.g. 🥦, 🌶️"
                                  onChange={e => updateField(index, { icon: e.target.value })}
                                  className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-sm outline-none focus:border-indigo-400"
                                />
                              </label>
                            </div>

                            <div className="mb-3">
                               <span className="text-[10px] font-bold text-slate-400 uppercase ml-1">Applies to Categories (Empty = All)</span>
                               <div className="flex flex-wrap gap-2 mt-1">
                                  {editingTenant.categories?.map(cat => (
                                    <button
                                      key={cat}
                                      type="button"
                                      onClick={() => {
                                        const current = item.appliesTo || [];
                                        const next = current.includes(cat) 
                                          ? current.filter(c => c !== cat)
                                          : [...current, cat];
                                        updateField(index, { appliesTo: next });
                                      }}
                                      className={`px-3 py-1 rounded-full text-[10px] font-bold transition-all ${
                                        item.appliesTo?.includes(cat)
                                          ? 'bg-indigo-600 text-white'
                                          : 'bg-slate-100 text-slate-400 hover:bg-slate-200'
                                      }`}
                                    >
                                      {cat}
                                    </button>
                                  ))}
                                  {(editingTenant.categories?.length || 0) === 0 && (
                                    <p className="text-[10px] text-slate-400 italic">No categories defined yet.</p>
                                  )}
                               </div>
                            </div>
                            
                            
                            { (item.type === 'select' || item.type === 'number') && (
                              <label className="block mb-3">
                                <span className="text-[10px] font-bold text-slate-400 uppercase ml-1">
                                  {item.type === 'number' ? 'Value Labels (0, 1, 2, 3... comma separated)' : 'Options (comma-separated)'}
                                </span>
                                <input 
                                  value={item.options?.join(', ') || ''} 
                                  onChange={e => updateField(index, { options: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })}
                                  placeholder="e.g. Small, Medium, Large"
                                  className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-sm outline-none focus:border-indigo-400"
                                />
                              </label>
                            )}

                            <label className="flex items-center gap-2 cursor-pointer">
                              <input 
                                type="checkbox" 
                                checked={!!item.required} 
                                onChange={e => updateField(index, { required: e.target.checked })}
                                className="w-4 h-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                              />
                              <span className="text-xs font-semibold text-slate-600">Mark as Required</span>
                            </label>
                          </div>
                        ))}
                        
                        {localSchema.length === 0 && (
                          <div className="text-center py-8 border-2 border-dashed border-slate-200 rounded-3xl">
                            <p className="text-sm text-slate-400">No custom fields defined yet.</p>
                            <p className="text-xs text-slate-300 mt-1">Tenant will only see default name, description, and price.</p>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex gap-3 pt-4">
                    <button 
                      type="submit" 
                      disabled={updateTenantMutation.isPending}
                      className="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white font-medium py-3 rounded-2xl transition-colors disabled:opacity-50"
                    >
                      {updateTenantMutation.isPending ? 'Saving Configuration...' : 'Save Configuration'}
                    </button>
                    <button 
                      type="button"
                      onClick={() => setEditingTenant(null)}
                      className="px-6 py-3 border border-slate-200 text-slate-600 font-medium rounded-2xl hover:bg-slate-50 transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}
        </div>
      </main>
    );
  }

  const summary = summaryQuery.data;
  const currentTenantSchema = tenantQuery.data?.productSchema || [];

  return (
    <>
    <main className="min-h-screen px-4 py-6 md:px-8">
      <div className="mx-auto max-w-7xl">
        <header className="rounded-[2rem] bg-ink px-6 py-8 text-white shadow-panel md:px-8">
          <div className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
            <div>
              <p className="text-sm uppercase tracking-[0.3em] text-red-200">{tenantQuery.data?.name || 'Loading...'}</p>
              <nav className="mt-4 flex gap-8 border-b border-white/10">
                 <button 
                  onClick={() => setActiveTab('dashboard')}
                  className={`pb-4 text-sm font-medium transition-colors ${activeTab === 'dashboard' ? 'text-white border-b-2 border-ember' : 'text-white/40 hover:text-white/60'}`}
                 >Dashboard</button>
                 <button 
                  onClick={() => setActiveTab('pos')}
                  className={`pb-4 text-sm font-medium transition-colors ${activeTab === 'pos' ? 'text-white border-b-2 border-ember' : 'text-white/40 hover:text-white/60'}`}
                 >POS (New Order)</button>
                 <button 
                  onClick={() => setActiveTab('settings')}
                  className={`pb-4 text-sm font-medium transition-colors ${activeTab === 'settings' ? 'text-white border-b-2 border-ember' : 'text-white/40 hover:text-white/60'}`}
                 >Business Settings</button>
              </nav>
            </div>
            <button
              className="rounded-full border border-white/20 px-5 py-3 text-sm text-white/80 transition hover:bg-white/10"
              onClick={() => {
                window.localStorage.clear();
                window.location.reload();
              }}
            >
              Logout
            </button>
          </div>
        </header>

        {activeTab === 'dashboard' ? (
          <>
            <section className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-5">
              {[
                ['Orders', summary?.ordersCount ?? 0],
                ['Pending', summary?.pendingOrdersCount ?? 0],
                ['Completed', summary?.completedOrdersCount ?? 0],
                ['Reviews', summary?.reviewsCount ?? 0],
                ['Products', summary?.productCount ?? 0],
              ].map(([label, value]) => (
                <article key={label} className="rounded-[1.5rem] bg-white p-5 shadow-panel">
                  <p className="text-sm text-slate-500">{label}</p>
                  <p className="mt-3 font-display text-4xl text-ink">{value}</p>
                </article>
              ))}
            </section>

            <section className="mt-6 grid gap-6 xl:grid-cols-[1.4fr_1fr]">

              {/* ── Two-Panel Chat System ─────────────────────────────── */}
              <article className="rounded-[2rem] bg-white shadow-panel overflow-hidden" style={{ minHeight: '520px' }}>
                <div className="flex h-full" style={{ minHeight: '520px' }}>

                  {/* Left Panel: Conversation List */}
                  <div className="w-72 flex-shrink-0 border-r border-slate-100 flex flex-col">
                    <div className="px-5 pt-5 pb-3 border-b border-slate-100">
                      <div className="flex items-center justify-between">
                        <h2 className="font-display text-xl text-ink">Conversations</h2>
                        {(conversationsQuery.data?.reduce((s, c) => s + c.unresolvedAlertCount, 0) ?? 0) > 0 && (
                          <span className="bg-red-500 text-white text-[10px] font-bold px-2 py-0.5 rounded-full animate-pulse">
                            {conversationsQuery.data?.reduce((s, c) => s + c.unresolvedAlertCount, 0)} new
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex-1 overflow-y-auto divide-y divide-slate-50">
                      {conversationsQuery.data?.length === 0 && (
                        <div className="p-6 text-center text-slate-400 text-sm">No conversations yet</div>
                      )}
                      {conversationsQuery.data?.map((conv) => (
                        <button
                          key={conv.customerPhone}
                          onClick={() => { setSelectedPhone(conv.customerPhone); setChatInput(''); }}
                          className={`w-full text-left px-4 py-3 transition-all hover:bg-slate-50 relative ${
                            selectedPhone === conv.customerPhone 
                              ? 'bg-indigo-50 border-l-4 border-indigo-500' 
                              : conv.unresolvedAlertCount > 0 
                                ? 'bg-orange-50/60 border-l-4 border-orange-400' 
                                : ''
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className={`text-sm truncate ${conv.unresolvedAlertCount > 0 ? 'font-extrabold text-orange-900' : 'font-bold text-ink'}`}>
                              {conv.customerPhone}
                            </span>
                            <div className="flex items-center gap-1.5 flex-shrink-0">
                              {conv.unresolvedAlertCount > 0 && (
                                <span className="flex items-center gap-1 bg-orange-500 text-white text-[8px] font-bold px-1.5 py-0.5 rounded-full animate-bounce shadow-sm">
                                  NEW
                                </span>
                              )}
                              <span className="text-[10px] text-slate-400">
                                {new Date(conv.lastMessageAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                              </span>
                            </div>
                          </div>
                          <div className="flex items-center gap-1 mt-0.5">
                            <span className="text-[10px] text-slate-400">
                              {conv.lastMessageSender === 'USER' ? '👤' : conv.lastMessageSender === 'BOT' ? '🤖' : '🧑‍🍳'}
                            </span>
                            <p className={`text-xs truncate ${conv.unresolvedAlertCount > 0 ? 'text-orange-700 font-medium' : 'text-slate-500'}`}>
                              {conv.lastMessage}
                            </p>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Right Panel: Chat Thread */}
                  <div className="flex-1 flex flex-col min-w-0">
                    {!selectedPhone ? (
                      <div className="flex-1 flex flex-col items-center justify-center text-slate-300 gap-3">
                        <span className="text-5xl">💬</span>
                        <p className="text-sm font-medium">Select a conversation to view messages</p>
                      </div>
                    ) : (
                      <>
                        {/* Chat header */}
                        <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between">
                          <div>
                            <p className="font-bold text-sm text-ink">{selectedPhone}</p>
                            <p className="text-[10px] text-slate-400">{chatHistoryQuery.data?.length ?? 0} messages</p>
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => {
                                setPosPhone(selectedPhone);
                                setPosItems([]);
                                setActiveTab('pos');
                              }}
                              className="text-[10px] font-bold bg-indigo-50 text-indigo-600 border border-indigo-100 px-3 py-1.5 rounded-lg hover:bg-indigo-100 transition-all font-display"
                            >
                              📦 Start POS Order
                            </button>
                            {(conversationsQuery.data?.find(c => c.customerPhone === selectedPhone)?.unresolvedAlertCount ?? 0) > 0 && (
                              <button
                                onClick={() => resolveConversationMutation.mutate(selectedPhone)}
                                disabled={resolveConversationMutation.isPending}
                                className="text-[10px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-100 px-3 py-1.5 rounded-lg hover:bg-emerald-100 transition-all disabled:opacity-50"
                              >
                                ✅ Resolve All
                              </button>
                            )}
                          </div>
                        </div>

                        {/* Message bubbles */}
                        <div className="flex-1 overflow-y-auto p-4 space-y-3" style={{ maxHeight: '360px' }}>
                          {chatHistoryQuery.isLoading && (
                            <div className="text-center text-slate-400 text-sm py-8">Loading messages...</div>
                          )}
                          {chatHistoryQuery.data?.map((msg) => {
                            const isUser = msg.sender === 'USER';
                            const isBot = msg.sender === 'BOT';
                            const isSystem = msg.sender === 'SYSTEM';

                            if (isSystem) {
                              return (
                                <div key={msg.id} className="flex justify-center my-4">
                                  <div className="bg-orange-50 border border-orange-100 rounded-full px-4 py-1 flex items-center gap-2 shadow-sm">
                                    <span className="text-[10px]">⚠️</span>
                                    <span className="text-[11px] font-bold text-orange-700 tracking-tight uppercase">{msg.content}</span>
                                    <span className="text-[9px] text-orange-400 font-medium">
                                      {new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                    </span>
                                  </div>
                                </div>
                              );
                            }

                            return (
                              <div key={msg.id} className={`flex ${isUser ? 'justify-start' : 'justify-end'}`}>
                                <div className={`max-w-[75%]`}>
                                  <div className={`px-4 py-2.5 rounded-2xl text-sm leading-relaxed ${
                                    isUser
                                      ? 'bg-slate-100 text-slate-800 rounded-tl-sm'
                                      : isBot
                                        ? 'bg-indigo-500 text-white rounded-tr-sm shadow-md'
                                        : 'bg-emerald-500 text-white rounded-tr-sm shadow-md'
                                  }`}>
                                    {msg.content}
                                  </div>
                                  <div className={`flex items-center gap-1 mt-1 ${isUser ? 'justify-start' : 'justify-end'}`}>
                                    <span className="text-[9px] font-bold uppercase tracking-tighter text-slate-400">
                                      {isBot ? '🤖 Bot' : isUser ? '👤 Customer' : '🧑‍🍳 Staff'}
                                    </span>
                                    <span className="text-[9px] text-slate-300">·</span>
                                    <span className="text-[9px] text-slate-400">
                                      {new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                    </span>
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                          <div ref={chatBottomRef} />
                        </div>

                        {/* Reply box */}
                        <div className="px-4 py-3 border-t border-slate-100 flex gap-2 items-end">
                          <textarea
                            className="flex-1 rounded-2xl border border-slate-200 px-4 py-2.5 text-sm focus:ring-2 focus:ring-indigo-400 focus:border-transparent outline-none resize-none"
                            placeholder={`Reply to ${selectedPhone}...`}
                            rows={2}
                            value={chatInput}
                            onChange={(e) => setChatInput(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' && !e.shiftKey && chatInput.trim()) {
                                e.preventDefault();
                                chatSendMutation.mutate({ customerPhone: selectedPhone, message: chatInput });
                              }
                            }}
                          />
                          <button
                            className="bg-indigo-600 text-white px-4 py-2.5 rounded-2xl font-bold text-sm shadow-lg shadow-indigo-200 hover:bg-indigo-700 transition-all disabled:opacity-40 flex-shrink-0"
                            disabled={!chatInput.trim() || chatSendMutation.isPending}
                            onClick={() => chatSendMutation.mutate({ customerPhone: selectedPhone, message: chatInput })}
                          >
                            {chatSendMutation.isPending ? '...' : '🚀 Send'}
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              </article>

              {/* ── Right column: Orders + Products ───────────────────── */}
              <article className="rounded-[2rem] bg-white p-6 shadow-panel">
                <div>
                  <h2 className="font-display text-3xl text-ink">Orders</h2>
                  <p className="mt-2 text-sm text-slate-500">Update status to trigger customer notifications and review collection.</p>
                </div>
                {/* ... existing orders table ... */}
                <div className="mt-6 overflow-x-auto">
                  <table className="min-w-full text-left text-sm">
                    <thead className="text-slate-500">
                      <tr>
                        <th className="pb-3">Customer</th>
                        <th className="pb-3">Details</th>
                        <th className="pb-3">Amount</th>
                        <th className="pb-3">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {ordersQuery.data?.map((order) => (
                        <Fragment key={order.id}>
                          <tr className={`transition-all duration-500 rounded-2xl ${getOrderStatusStyles(order)}`}>
                            <td className="py-4 px-4 pr-4">
                              <div className="flex items-center gap-2">
                                <div className="font-medium text-ink">{order.customerPhone}</div>
                                {order.source === 'MANUAL' ? (
                                  <span className="text-[9px] bg-indigo-100 text-indigo-600 px-1.5 py-0.5 rounded-md font-bold uppercase tracking-tighter">👤 Staff</span>
                                ) : (
                                  <span className="text-[9px] bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded-md font-bold uppercase tracking-tighter">🤖 Bot</span>
                                )}
                              </div>
                              <div className="text-[10px] font-mono font-bold tracking-tighter text-indigo-500 bg-indigo-50 px-1.5 py-0.5 rounded-md inline-block mt-1">
                                {maskId(order.id)}
                              </div>
                            </td>
                            <td className="py-4 pr-4">
                              <div className="text-xs font-semibold text-slate-700">
                                {order.orderItems.map((item) => item.product.name).join(', ')}
                              </div>
                              <div className="text-[10px] text-slate-400 mt-1">
                                {new Date(order.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                              </div>
                            </td>
                            <td className="py-4 pr-4 font-display text-ink font-bold">{formatPrice(order.totalAmount)}</td>
                            <td className="py-4 pr-4">
                              <div className="flex items-center justify-end gap-2">
                                <button
                                  className={`text-[10px] font-bold px-3 py-1.5 rounded-lg transition-all ${
                                    replyingTo === order.id 
                                      ? 'bg-ink text-white' 
                                      : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'
                                  }`}
                                  onClick={() => {
                                    setReplyingTo(replyingTo === order.id ? null : order.id);
                                    setReplyMessage('');
                                  }}
                                >
                                  {replyingTo === order.id ? 'Close Chat' : '💬 Chat'}
                                </button>
                                <select
                                  className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold bg-white"
                                  value={order.status}
                                  onChange={(event) =>
                                    statusMutation.mutate({ orderId: order.id, status: event.target.value })
                                  }
                                >
                                  {statusOptions.map((status) => (
                                    <option key={status} value={status}>{status}</option>
                                  ))}
                                </select>
                              </div>
                            </td>
                          </tr>
                          {replyingTo === order.id && (
                            <tr className="bg-indigo-50/30">
                              <td colSpan={4} className="p-4">
                                <div className="flex gap-3 items-end">
                                  <div className="flex-1">
                                    <label className="block text-[10px] uppercase tracking-wider font-bold text-indigo-400 mb-1">
                                      Chat with {order.customerPhone} (Order {maskId(order.id)})
                                    </label>
                                    <textarea
                                      className="w-full rounded-xl border border-indigo-100 p-3 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none shadow-sm"
                                      placeholder="Type your message here..."
                                      rows={2}
                                      value={replyMessage}
                                      onChange={(e) => setReplyMessage(e.target.value)}
                                    />
                                  </div>
                                  <button
                                    className="bg-indigo-600 text-white px-6 py-3 rounded-xl font-bold text-sm shadow-lg shadow-indigo-200 hover:bg-indigo-700 transition-all disabled:opacity-50"
                                    disabled={!replyMessage.trim() || replyMutation.isPending}
                                    onClick={() => replyMutation.mutate({ 
                                      customerPhone: order.customerPhone, 
                                      message: replyMessage 
                                    })}
                                  >
                                    {replyMutation.isPending ? 'Sending...' : 'Send Message 🚀'}
                                  </button>
                                </div>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      ))}
                    </tbody>
                  </table>
                </div>
              </article>

              <article className="rounded-[2rem] bg-white p-6 shadow-panel">
                {/* ... existing products list/form ... */}
                <div>
                  <h2 className="font-display text-3xl text-ink">Products</h2>
                  <p className="mt-2 text-sm text-slate-500">Add or edit items using your specific business schema.</p>
                </div>
                <form
                  className="mt-6 grid gap-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    productMutation.mutate();
                  }}
                >
                  <input
                    className="rounded-2xl border border-slate-200 px-4 py-3 shadow-sm outline-none focus:border-ember"
                    placeholder="Product name"
                    value={productForm.name}
                    onChange={(event) => setProductForm((current) => ({ ...current, name: event.target.value }))}
                    required
                  />
                  <textarea
                    className="min-h-24 rounded-2xl border border-slate-200 px-4 py-3 shadow-sm outline-none focus:border-ember"
                    placeholder="Description"
                    value={productForm.description}
                    onChange={(event) => setProductForm((current) => ({ ...current, description: event.target.value }))}
                    required
                  />
                  <input
                    className="rounded-2xl border border-slate-200 px-4 py-3 shadow-sm outline-none focus:border-ember"
                    placeholder="Price"
                    value={productForm.price}
                    onChange={(event) => setProductForm((current) => ({ ...current, price: event.target.value }))}
                    required
                  />

                  <div className="space-y-1">
                    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest ml-2 block">Default Tax Rate (%)</p>
                    <input
                      type="number"
                      className="w-full rounded-2xl border border-slate-200 px-4 py-3 shadow-sm outline-none focus:border-ember"
                      placeholder="Tax Rate (%) e.g. 5, 12, 18"
                      value={productForm.taxRate}
                      onChange={(event) => setProductForm((current) => ({ ...current, taxRate: event.target.value }))}
                      required
                    />
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest ml-2 block">Classification</p>
                      <div className="flex bg-slate-100 rounded-2xl p-1.5 h-[53px]">
                         <button 
                           type="button"
                           className={`flex-1 rounded-xl text-[10px] font-bold flex items-center justify-center gap-2 transition-all ${productForm.isVeg ? 'bg-white text-emerald-600 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}
                           onClick={() => setProductForm(c => ({ ...c, isVeg: true }))}
                         >
                           <span className={`w-2 h-2 rounded-full ${productForm.isVeg ? 'bg-emerald-500' : 'bg-slate-300'}`} /> VEG
                         </button>
                         <button 
                           type="button"
                           className={`flex-1 rounded-xl text-[10px] font-bold flex items-center justify-center gap-2 transition-all ${!productForm.isVeg ? 'bg-white text-rose-600 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}
                           onClick={() => setProductForm(c => ({ ...c, isVeg: false }))}
                         >
                           <span className={`w-2 h-2 rounded-full ${!productForm.isVeg ? 'bg-rose-500' : 'bg-slate-300'}`} /> NON-VEG
                         </button>
                      </div>
                    </div>

                    <div className="space-y-1">
                      <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest ml-2 block">Category</p>
                      <select
                        className="w-full rounded-2xl border border-slate-200 px-4 py-3 h-[53px] shadow-sm outline-none focus:border-ember bg-white text-sm font-medium"
                        value={productForm.category}
                        onChange={(e) => setProductForm(c => ({ ...c, category: e.target.value }))}
                        required
                      >
                        <option value="General">Select Category</option>
                        {tenantQuery.data?.categories?.map(cat => (
                          <option key={cat} value={cat}>{cat}</option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <p className="text-xs text-slate-500 mb-1 ml-2">Product Image</p>
                    <div className="flex items-center gap-4">
                      {productForm.imageUrl && (
                        <img 
                          src={productForm.imageUrl.startsWith('http') ? productForm.imageUrl : `${api.defaults.baseURL}${productForm.imageUrl}`} 
                          alt="Preview" 
                          className="w-16 h-16 rounded-xl object-cover border border-slate-200"
                        />
                      )}
                      <label className="flex-1 flex flex-col items-center justify-center h-16 px-4 border-2 border-dashed border-slate-200 rounded-xl cursor-pointer hover:border-indigo-400 transition-colors">
                        <span className="text-xs font-medium text-slate-500">
                          {productForm.imageUrl ? 'Change Image' : 'Upload Image'}
                        </span>
                        <input 
                          type="file" 
                          accept="image/*" 
                          className="hidden" 
                          onChange={async (e) => {
                            const file = e.target.files?.[0];
                            if (!file) return;
                            
                            const formData = new FormData();
                            formData.append('file', file);
                            
                            try {
                              const res = await api.post('/upload', formData, {
                                headers: { 'Content-Type': 'multipart/form-data' }
                              });
                              setProductForm(c => ({ ...c, imageUrl: res.data.url }));
                            } catch (error: any) {
                              alert('Upload failed: ' + (error.response?.data?.message || error.message));
                            }
                          }}
                        />
                      </label>
                    </div>
                  </div>

                  <input
                    className="rounded-2xl border border-slate-200 px-4 py-3 shadow-sm outline-none focus:border-ember"
                    placeholder="Tags (best seller, new, etc. - comma separated)"
                    value={productForm.tags_raw}
                    onChange={(e) => setProductForm(c => ({ ...c, tags_raw: e.target.value }))}
                  />

                  {currentTenantSchema.filter(field => {
                    // Filter based on selected category
                    if (!field.appliesTo || field.appliesTo.length === 0) return true;
                    return field.appliesTo.includes(productForm.category);
                  }).map((field) => {
                    const fieldKey = (field.name || field.id) as string;
                    return (
                      <div key={fieldKey}>
                        <p className="text-xs text-slate-500 mb-1 ml-2">
                          {field.label || field.name || field.id} {field.required ? '*' : ''}
                        </p>
                        {field.type === 'select' ? (
                          <select
                            className="w-full rounded-2xl border border-slate-200 px-4 py-3 shadow-sm outline-none focus:border-ember"
                            value={productForm.attributes[fieldKey] || ''}
                            onChange={(e) => setProductForm(c => ({ ...c, attributes: { ...c.attributes, [fieldKey]: e.target.value } }))}
                            required={field.required}
                          >
                            <option value="">Select {field.label || field.name || field.id}</option>
                            {field.options?.map(opt => <option key={opt} value={opt}>{opt}</option>)}
                          </select>
                        ) : field.type === 'boolean' ? (
                          <label className="flex items-center gap-2 p-3 rounded-2xl border border-slate-100 bg-slate-50/50">
                            <input 
                              type="checkbox"
                              className="h-5 w-5 rounded border-slate-300 text-ember focus:ring-ember"
                              checked={!!productForm.attributes[fieldKey]}
                              onChange={(e) => setProductForm(c => ({ ...c, attributes: { ...c.attributes, [fieldKey]: e.target.checked } }))}
                            />
                            <span className="text-sm font-medium text-slate-700">{field.label || field.name || field.id}</span>
                          </label>
                        ) : (field.type === 'number' && field.options && field.options.length > 0) ? (
                          <div className="flex flex-wrap gap-2 mt-1">
                            {field.options.map((label, i) => (
                              <button
                                key={label}
                                type="button"
                                onClick={() => setProductForm(c => ({ ...c, attributes: { ...c.attributes, [fieldKey]: i } }))}
                                className={`px-4 py-2 rounded-xl text-xs font-bold transition-all border ${
                                  (productForm.attributes[fieldKey] ?? 0) === i
                                    ? 'bg-ember border-ember text-white shadow-md'
                                    : 'bg-white border-slate-200 text-slate-500 hover:border-indigo-400'
                                }`}
                              >
                                <span className="block opacity-60 text-[8px] uppercase">{i}</span>
                                {label}
                              </button>
                            ))}
                          </div>
                        ) : (
                          <input
                            type={field.type === 'number' ? 'number' : 'text'}
                            className="w-full rounded-2xl border border-slate-200 px-4 py-3 shadow-sm outline-none focus:border-ember"
                            placeholder={field.label || field.name || field.id}
                            value={productForm.attributes[fieldKey] ?? ''}
                            onChange={(e) => {
                              const val = e.target.value;
                              const finalVal = field.type === 'number' ? (val === '' ? undefined : Number(val)) : val;
                              setProductForm(c => ({ ...c, attributes: { ...c.attributes, [fieldKey]: finalVal } }));
                            }}
                            required={field.required}
                          />
                        )}
                      </div>
                    );
                  })}

                  <button className="rounded-2xl bg-ink px-4 py-4 font-medium text-white transition hover:bg-slate-800" type="submit" disabled={productMutation.isPending}>
                    {editingProductId ? 'Update item' : 'Add item to catalog'}
                  </button>
                </form>

                <div className="mt-6 space-y-3">
                  {productQuery.data?.map((p) => (
                    <div key={p.id} className="rounded-[1.5rem] border border-slate-100 p-4 hover:bg-slate-50 transition group">
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex items-center gap-4">
                          <div className="w-14 h-14 rounded-2xl bg-slate-100 overflow-hidden flex-shrink-0 relative">
                            {p.imageUrl ? (
                              <img 
                                src={p.imageUrl.startsWith('http') ? p.imageUrl : `${api.defaults.baseURL}${p.imageUrl}`} 
                                className="w-full h-full object-cover" 
                                alt={p.name} 
                              />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center text-slate-300 text-xl">
                                🍴
                              </div>
                            )}
                            <div className={`absolute top-1 right-1 w-2.5 h-2.5 rounded-full border-2 border-white shadow-sm ${p.isVeg ? 'bg-emerald-500' : 'bg-rose-500'}`} />
                          </div>
                          <div>
                            <div className="flex items-center gap-2 mb-0.5">
                              <p className="font-bold text-ink">{p.name}</p>
                              <span className={`text-[8px] font-black px-1.5 py-0.5 rounded border ${p.isVeg ? 'border-emerald-200 text-emerald-600 bg-emerald-50' : 'border-rose-200 text-rose-600 bg-rose-50'}`}>
                                {p.isVeg ? 'VEG' : 'NON-VEG'}
                              </span>
                            </div>
                            <p className="text-sm font-bold text-ember">{formatPrice(p.price)}</p>
                          </div>
                        </div>
                        <div className="flex gap-2">
                          <button
                            className="w-10 h-10 rounded-xl bg-white border border-slate-200 flex items-center justify-center text-slate-400 hover:text-ink hover:border-ink transition-all"
                            onClick={() => {
                              setEditingProductId(p.id);
                              setProductForm({
                                name: p.name,
                                description: p.description,
                                price: p.price,
                                isVeg: p.isVeg,
                                taxRate: (Number(p.taxRate) * 100).toString(),
                                isAvailable: p.isAvailable,
                                attributes: p.attributes || {},
                                category: p.category || 'General',
                                imageUrl: p.imageUrl || '',
                                tags_raw: (p.tags as string[])?.join(', ') || '',
                              });
                            }}
                            title="Edit Product"
                          >
                             <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
                          </button>
                          <button
                            className="w-10 h-10 rounded-xl bg-white border border-slate-200 flex items-center justify-center text-slate-400 hover:text-rose-600 hover:border-rose-200 transition-all"
                            onClick={() => {
                              if (confirm('Are you sure you want to delete this product?')) {
                                deleteProductMutation.mutate(p.id);
                              }
                            }}
                            title="Delete Product"
                          >
                             <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
                          </button>
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-2 mt-3">
                        <span className="text-[9px] font-bold px-2 py-1 bg-slate-100 text-slate-500 rounded-lg uppercase tracking-wider">
                          {p.category}
                        </span>
                        {(p.tags as string[] | undefined)?.map(tag => (
                          <span key={tag} className="text-[9px] font-bold px-2 py-1 bg-indigo-50 text-indigo-500 rounded-lg uppercase tracking-wider">
                            {tag}
                          </span>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </article>
            </section>
          </>
        ) : activeTab === 'pos' ? (
          <section className="mt-6 flex flex-col lg:flex-row gap-6 items-stretch min-h-[700px] animate-in fade-in slide-in-from-bottom-4 duration-500">
            {/* Left: Product Selection */}
            <article className="lg:w-3/5 rounded-[2rem] bg-indigo-50/20 p-8 shadow-panel border border-indigo-100/50 flex flex-col">
               <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
                 <div>
                   <h2 className="font-display text-3xl text-ink">Storefront Catalog</h2>
                   <p className="text-sm text-slate-500 mt-1">Select products to build a comprehensive order.</p>
                 </div>
                 <div className="relative w-full md:w-64">
                   <input 
                     type="text"
                     placeholder="Search or category..."
                     className="w-full bg-white border border-slate-200 rounded-2xl pl-10 pr-4 py-3 text-sm outline-none focus:ring-4 focus:ring-indigo-500/10 focus:border-indigo-500 transition-all shadow-sm"
                     value={posSearch}
                     onChange={(e) => setPosSearch(e.target.value)}
                   />
                   <span className="absolute left-4 top-3.5 text-slate-400">🔍</span>
                 </div>
               </div>

               <div className="flex gap-2 mb-6 overflow-x-auto pb-2 scrollbar-hide">
                 <button 
                  onClick={() => setPosSearch('')}
                  className={`px-5 py-2 rounded-full text-xs font-bold whitespace-nowrap transition-all ${!posSearch ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-100' : 'bg-white text-slate-500 border border-slate-200 hover:border-indigo-300'}`}
                 >
                   All Items
                 </button>
                 {tenantQuery.data?.categories?.map((cat: string) => (
                    <button 
                      key={cat}
                      onClick={() => setPosSearch(cat)}
                      className={`px-5 py-2 rounded-full text-xs font-bold whitespace-nowrap transition-all ${posSearch === cat ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-100' : 'bg-white text-slate-500 border border-slate-200 hover:border-indigo-300'}`}
                    >
                      {cat}
                    </button>
                 ))}
               </div>

               <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-4 overflow-y-auto pr-2 max-h-[600px] scrollbar-hide">
                 {productsQuery.data?.filter(p => p.isAvailable && (p.name.toLowerCase().includes(posSearch.toLowerCase()) || p.category.toLowerCase().includes(posSearch.toLowerCase()))).map(product => {
                    const inCart = posItems.find(i => i.productId === product.id);
                    return (
                      <div key={product.id} className="group relative bg-white p-5 rounded-[2.5rem] border border-slate-100 shadow-sm hover:shadow-2xl hover:border-indigo-200 transition-all cursor-pointer flex gap-5 items-center"
                           onClick={() => {
                             if (!inCart) {
                               setPosItems(curr => [...curr, { 
                                 productId: product.id, 
                                 quantity: 1, 
                                 taxEnabled: true, 
                                 taxRate: Number(product.taxRate || tenantQuery.data?.taxRate || 0.05) 
                               }]);
                             }
                           }}>
                        <div className="w-20 h-20 rounded-3xl overflow-hidden bg-slate-50 flex-shrink-0 border border-slate-50 relative">
                          {product.imageUrl ? (
                            <img 
                              src={product.imageUrl.startsWith('http') ? product.imageUrl : `${api.defaults.baseURL}${product.imageUrl}`} 
                              className="w-full h-full object-cover" 
                            />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center text-slate-200 text-3xl font-display">
                              🍴
                            </div>
                          )}
                          <div className={`absolute top-1.5 right-1.5 w-3 h-3 rounded-full border-2 border-white shadow-sm ${product.isVeg ? 'bg-emerald-500' : 'bg-rose-500'}`} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <h4 className="font-bold text-ink text-base truncate">{product.name}</h4>
                          <p className="text-indigo-600 font-display font-bold text-lg mt-0.5">{formatPrice(product.price)}</p>
                          <div className="flex items-center gap-2 mt-1.5">
                            <span className="text-[9px] font-bold text-slate-400 uppercase tracking-widest bg-slate-50 px-2 py-0.5 rounded-md border border-slate-100">{product.category}</span>
                          </div>
                        </div>
                        <div className="absolute top-6 right-6 translate-x-1 -translate-y-1 opacity-0 group-hover:opacity-100 transition-all scale-90 group-hover:scale-100">
                           <div className="w-10 h-10 rounded-full bg-indigo-600 text-white flex items-center justify-center shadow-xl font-bold">+</div>
                        </div>
                        {inCart && (
                           <div className="absolute inset-0 bg-indigo-600/10 border-2 border-indigo-600 rounded-[2.5rem] flex items-center justify-center backdrop-blur-[1px] animate-in zoom-in duration-200">
                             <div className="bg-indigo-600 text-white text-[11px] font-bold px-4 py-1.5 rounded-full shadow-xl flex items-center gap-2">
                               <span>✅</span>
                               <span>ADDED {inCart.quantity > 1 ? `(${inCart.quantity})` : ''}</span>
                             </div>
                           </div>
                        )}
                      </div>
                    );
                 })}
               </div>
            </article>

            {/* Right: Checkout Cart */}
            <article className="lg:w-2/5 rounded-[2rem] bg-white p-8 shadow-panel border border-slate-100 flex flex-col relative overflow-hidden">
               <div className="absolute top-0 right-0 w-32 h-32 bg-indigo-50/50 rounded-bl-[100%] z-0 pointer-events-none" />
               
               <div className="flex items-center justify-between mb-8 relative z-10">
                 <h3 className="font-display text-2xl text-ink">Order Summary</h3>
                 <button 
                  onClick={() => { setPosItems([]); setPosPhone(''); setPosDiscount(''); }}
                  className="text-[10px] font-bold text-slate-400 hover:text-red-500 transition-colors uppercase tracking-widest"
                 >Reset Cart</button>
               </div>

               <div className="space-y-6 flex-1 overflow-y-auto px-1 scrollbar-hide relative z-10">
                  <div className="space-y-2">
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest ml-1">Customer Phone</label>
                    <div className="flex gap-2">
                      <input 
                        type="text"
                        placeholder="e.g. 919876543210"
                        className="flex-1 bg-slate-50 border border-slate-100 rounded-2xl px-4 py-3.5 text-sm outline-none focus:bg-white focus:border-indigo-600 transition-all font-bold shadow-sm"
                        value={posPhone}
                        onChange={(e) => setPosPhone(e.target.value)}
                      />
                      <button 
                        className="bg-white text-indigo-600 px-5 rounded-2xl text-xs font-bold hover:bg-indigo-50 transition-all border border-indigo-100 shadow-sm"
                        onClick={() => {
                          const lastConversation = conversationsQuery.data?.[0];
                          if (lastConversation) setPosPhone(lastConversation.customerPhone);
                        }}
                      >Recent 👤</button>
                    </div>
                  </div>

                  <div className="space-y-4">
                     <div className="flex items-center justify-between ml-1">
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Cart Items ({posItems.length})</label>
                        {posItems.length > 0 && (
                           <span className="text-[10px] font-bold text-indigo-600">Total Weight: {posItems.reduce((acc, i) => acc + i.quantity, 0)} units</span>
                        )}
                     </div>
                     {posItems.length === 0 ? (
                       <div className="py-20 text-center border-2 border-dashed border-slate-100 rounded-[2.5rem] bg-slate-50/50">
                         <p className="text-slate-300 text-sm font-medium">Select items from catalog to start</p>
                       </div>
                     ) : (
                       <div className="grid gap-3">
                         {posItems.map(item => {
                            const p = productsQuery.data?.find(pr => pr.id === item.productId);
                            if (!p) return null;
                            return (
                              <div key={item.productId} className="bg-slate-50/70 p-5 rounded-3xl space-y-4 border border-slate-100 shadow-sm animate-in slide-in-from-right-2 duration-300">
                                <div className="flex justify-between items-start">
                                  <div className="min-w-0">
                                    <h5 className="font-bold text-sm text-ink truncate">{p.name}</h5>
                                    <p className="text-xs text-slate-500 font-medium">{formatPrice(p.price)} per unit</p>
                                  </div>
                                  <button 
                                    className="w-8 h-8 flex items-center justify-center rounded-full bg-white text-slate-300 hover:text-red-500 hover:bg-red-50 transition-all shadow-sm"
                                    onClick={() => setPosItems(curr => curr.filter(i => i.productId !== item.productId))}
                                  >✕</button>
                                </div>
                                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                                   <div className="flex items-center bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-sm self-start">
                                      <button 
                                        className="px-4 py-2 hover:bg-slate-50 text-slate-500 font-bold transition-colors"
                                        onClick={() => setPosItems(curr => curr.map(i => i.productId === item.productId ? {...i, quantity: Math.max(1, i.quantity - 1)} : i))}
                                      >-</button>
                                      <span className="w-10 text-center text-sm font-bold border-x border-slate-50 py-2">{item.quantity}</span>
                                      <button 
                                        className="px-4 py-2 hover:bg-slate-50 text-slate-500 font-bold transition-colors"
                                        onClick={() => setPosItems(curr => curr.map(i => i.productId === item.productId ? {...i, quantity: i.quantity + 1} : i))}
                                      >+</button>
                                   </div>
                                   <div className="flex items-center gap-3">
                                      <div className="flex items-center gap-2">
                                        <button 
                                          className={`w-11 h-6 rounded-full transition-all relative flex items-center px-1.5 ${item.taxEnabled ? 'bg-indigo-600' : 'bg-slate-300'}`}
                                          onClick={() => setPosItems(curr => curr.map(i => i.productId === item.productId ? {...i, taxEnabled: !item.taxEnabled} : i))}
                                        >
                                          <div className={`w-3.5 h-3.5 bg-white rounded-full shadow-md transition-all ${item.taxEnabled ? 'translate-x-4.5' : 'translate-x-0'}`} />
                                        </button>
                                        <span className="text-[10px] font-bold text-slate-500 uppercase tracking-tighter">Tax</span>
                                      </div>
                                      {item.taxEnabled && (
                                        <div className="flex items-center bg-white border border-indigo-100 rounded-xl px-2.5 py-1 shadow-sm">
                                          <input 
                                            type="number"
                                            className="w-8 text-center text-xs font-bold text-indigo-600 bg-transparent outline-none"
                                            value={Math.round(item.taxRate * 100)}
                                            onChange={(e) => {
                                              const val = parseFloat(e.target.value) / 100;
                                              setPosItems(curr => curr.map(i => i.productId === item.productId ? {...i, taxRate: isNaN(val) ? 0 : val} : i));
                                            }}
                                          />
                                          <span className="text-[10px] font-bold text-indigo-400 font-display">%</span>
                                        </div>
                                      )}
                                   </div>
                                </div>
                              </div>
                            );
                         })}
                       </div>
                     )}
                  </div>

                  <div className="space-y-4 pt-4 border-t border-slate-100">
                     <div className="flex flex-col sm:flex-row gap-4">
                        <div className="flex-1 space-y-1">
                          <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest ml-1">Apply Discount (₹)</label>
                          <div className="relative">
                            <input 
                              type="number"
                              placeholder="0"
                              className="w-full bg-slate-50 border border-slate-100 rounded-2xl pl-8 pr-4 py-3.5 text-sm font-bold text-red-600 outline-none focus:bg-white focus:border-red-600 transition-all"
                              value={posDiscount}
                              onChange={(e) => setPosDiscount(e.target.value)}
                            />
                            <span className="absolute left-3.5 top-3.5 text-red-400">₹</span>
                          </div>
                        </div>
                        <div className="flex-1 space-y-1">
                           <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest ml-1">Payment Method</label>
                           <div className="flex bg-slate-100 rounded-2xl p-1.5 h-[53px]">
                              <button 
                                className={`flex-1 rounded-xl text-[10px] font-bold transition-all ${posPaymentMethod === 'COD' ? 'bg-white text-ink shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}
                                onClick={() => setPosPaymentMethod('COD')}
                              >CASH / COD</button>
                              <button 
                                className={`flex-1 rounded-xl text-[10px] font-bold transition-all ${posPaymentMethod === 'ONLINE' ? 'bg-white text-ink shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}
                                onClick={() => setPosPaymentMethod('ONLINE')}
                              >ONLINE / UPI</button>
                           </div>
                        </div>
                     </div>
                     <div className="space-y-1">
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest ml-1">Order Notes / Special Instructions</label>
                        <textarea 
                          placeholder="e.g. Extra spicy, less salt, deliver to gate 4..."
                          className="w-full bg-slate-50 border border-slate-100 rounded-2xl px-4 py-3 text-sm outline-none focus:bg-white focus:border-indigo-600 transition-all resize-none h-16"
                          value={posNotes}
                          onChange={(e) => setPosNotes(e.target.value)}
                        />
                     </div>
                  </div>
               </div>

               <div className="pt-8 border-t border-slate-100 space-y-5 relative z-10">
                 <div className="space-y-3">
                    <div className="flex justify-between text-sm font-medium text-slate-500">
                      <span>Subtotal</span>
                      <span className="text-ink font-bold">{formatPrice(posItems.reduce((acc, i) => acc + (Number(productsQuery.data?.find(p => p.id === i.productId)?.price || 0) * i.quantity), 0))}</span>
                    </div>
                    <div className="flex justify-between text-sm font-medium text-slate-500">
                      <span>Total Tax</span>
                      <span className="text-indigo-600 font-bold">+{formatPrice(posItems.reduce((acc, i) => {
                        const price = Number(productsQuery.data?.find(p => p.id === i.productId)?.price || 0);
                        return acc + (i.taxEnabled ? (price * i.quantity * i.taxRate) : 0);
                      }, 0))}</span>
                    </div>
                    {Number(posDiscount) > 0 && (
                      <div className="flex justify-between text-sm font-bold text-red-500 animate-in fade-in duration-300">
                        <span>Discount</span>
                        <span>- {formatPrice(posDiscount)}</span>
                      </div>
                    )}
                    <div className="flex justify-between text-3xl font-display font-bold text-ink pt-3 border-t border-slate-50">
                      <span>Net Total</span>
                      <span className="text-indigo-600">{formatPrice(Math.max(0, posItems.reduce((acc, i) => {
                        const price = Number(productsQuery.data?.find(p => p.id === i.productId)?.price || 0);
                        const tax = i.taxEnabled ? (price * i.quantity * i.taxRate) : 0;
                        return acc + (price * i.quantity) + tax;
                      }, -Number(posDiscount))))}</span>
                    </div>
                 </div>

                 <button 
                   className="w-full bg-ink text-white py-5 rounded-[2rem] font-bold text-sm shadow-2xl shadow-slate-200 hover:bg-slate-800 transition-all disabled:opacity-40 disabled:scale-100 active:scale-95 group overflow-hidden relative"
                   disabled={!posPhone || posItems.length === 0 || manualOrderMutation.isPending}
                   onClick={() => manualOrderMutation.mutate({ 
                     customerPhone: posPhone, 
                     items: posItems.map(i => ({ productId: i.productId, quantity: i.quantity, taxRate: i.taxEnabled ? i.taxRate : 0 })),
                     discount: Number(posDiscount),
                     notes: posNotes
                   })}
                 >
                   <span className="relative z-10 flex items-center justify-center gap-3">
                     {manualOrderMutation.isPending ? (
                       <>
                         <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                         Finalizing...
                       </>
                     ) : (
                       <>
                         Place Multi-Item Order 🛍️
                       </>
                     )}
                   </span>
                   {manualOrderMutation.isPending && (
                     <div className="absolute inset-0 bg-indigo-600 animate-pulse transition-all" />
                   )}
                 </button>
               </div>
            </article>
          </section>
        ) : (
          <section className="mt-6 grid gap-6 lg:grid-cols-2">
             <article className="rounded-[2rem] bg-white p-8 shadow-panel col-span-full">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="font-display text-3xl text-ink">AI Ordering Assistant</h2>
                    <p className="text-sm text-slate-500 mt-1">When disabled, all messages are flagged for manual response. No automated replies will be sent.</p>
                  </div>
                  <div className="flex items-center gap-4">
                     <span className={`text-[10px] font-bold uppercase tracking-widest px-3 py-1 rounded-full ${
                       tenantQuery.data?.isBotEnabled 
                        ? 'bg-indigo-100 text-indigo-700' 
                        : 'bg-slate-100 text-slate-500'
                     }`}>
                       {tenantQuery.data?.isBotEnabled ? 'Bot Active 🤖' : 'Manual Only 👤'}
                     </span>
                     <button 
                       onClick={() => updateTenantMutation.mutate({ 
                         id: tenantQuery.data?.id, 
                         isBotEnabled: !tenantQuery.data?.isBotEnabled 
                       })}
                       className={`relative inline-flex h-9 w-16 items-center rounded-full transition-all duration-300 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 ${
                         tenantQuery.data?.isBotEnabled ? 'bg-indigo-600 shadow-lg shadow-indigo-200' : 'bg-slate-200'
                       }`}
                     >
                       <span className={`inline-block h-7 w-7 transform rounded-full bg-white transition-transform duration-300 shadow-md ${
                         tenantQuery.data?.isBotEnabled ? 'translate-x-8' : 'translate-x-1'
                       }`} />
                     </button>
                  </div>
                </div>
             </article>

             <article className="rounded-[2rem] bg-white p-8 shadow-panel">
                <h2 className="font-display text-3xl text-ink mb-6">Business Operations</h2>
                <form className="space-y-6" onSubmit={(e) => {
                  e.preventDefault();
                  const fd = new FormData(e.currentTarget);
                  updateTenantMutation.mutate({
                    id: tenantQuery.data?.id,
                    openTime: fd.get('openTime') as string,
                    closeTime: fd.get('closeTime') as string,
                    timezone: fd.get('timezone') as string,
                  });
                }}>
                   <div className="grid grid-cols-2 gap-4">
                      <label className="block">
                        <span className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-2 block">Opening Time</span>
                        <input name="openTime" type="time" defaultValue={tenantQuery.data?.openTime} className="w-full rounded-2xl border border-slate-200 px-4 py-3 outline-none focus:border-ember" />
                      </label>
                      <label className="block">
                        <span className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-2 block">Closing Time</span>
                        <input name="closeTime" type="time" defaultValue={tenantQuery.data?.closeTime} className="w-full rounded-2xl border border-slate-200 px-4 py-3 outline-none focus:border-ember" />
                      </label>
                   </div>
                   <label className="block">
                      <span className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-2 block">Timezone</span>
                      <input name="timezone" defaultValue={tenantQuery.data?.timezone || 'Asia/Kolkata'} className="w-full rounded-2xl border border-slate-200 px-4 py-3 outline-none focus:border-ember" />
                   </label>
                   <button className="w-full rounded-2xl bg-ink py-4 font-medium text-white transition hover:bg-slate-800" type="submit">
                      Save Operations
                   </button>
                </form>
             </article>

             <article className="rounded-[2rem] bg-white p-8 shadow-panel">
                <h2 className="font-display text-3xl text-ink mb-2">WhatsApp Templates</h2>
                <p className="text-sm text-slate-500 mb-6 font-medium italic">Available placeholders: {"{{id}}, {{status}}, {{total}}, {{items}}"}</p>
                <form className="space-y-4" onSubmit={(e) => {
                   e.preventDefault();
                   const fd = new FormData(e.currentTarget);
                   const templates: any = {};
                   ['HELP_TEXT', 'MENU_HEADER', 'ORDER_PAYMENT_PROMPT', 'ORDER_STATUS', 'BUSINESS_CLOSED'].forEach(key => {
                      templates[key] = fd.get(key);
                   });
                   updateTenantMutation.mutate({
                      id: tenantQuery.data?.id,
                      messageTemplates: templates
                   });
                }}>
                   {[
                     ['HELP_TEXT', 'Help/Commands Message'],
                     ['MENU_HEADER', 'Menu Catalog Header'],
                     ['ORDER_PAYMENT_PROMPT', 'Payment Method Inquiry'],
                     ['ORDER_STATUS', 'Order Status Update'],
                     ['BUSINESS_CLOSED', 'Closed Auto-Reply'],
                   ].map(([id, label]) => (
                      <label key={id} className="block">
                         <span className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-2 block">{label}</span>
                         <textarea 
                          name={id}
                          rows={2}
                          defaultValue={(tenantQuery.data?.messageTemplates as any)?.[id] || ''} 
                          className="w-full rounded-2xl border border-slate-200 px-4 py-3 outline-none focus:border-ember text-sm font-mono"
                         />
                      </label>
                   ))}
                   <button className="w-full rounded-2xl bg-ink py-4 font-medium text-white transition hover:bg-slate-800" type="submit">
                      Update Templates
                   </button>
                </form>
             </article>
              <article className="rounded-[2rem] bg-white p-8 shadow-panel col-span-full">
                 <h2 className="font-display text-3xl text-ink mb-6">Menu Categories</h2>
                 <form className="space-y-4" onSubmit={(e) => {
                    e.preventDefault();
                    const fd = new FormData(e.currentTarget);
                    const cats = (fd.get('categories_raw') as string)
                        .split(',')
                        .map(s => s.trim())
                        .filter(Boolean);
                    
                    updateTenantMutation.mutate({
                        id: tenantQuery.data?.id,
                        categories: cats,
                    });
                 }}>
                    <label className="block">
                      <span className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-2 block">Categories (comma-separated)</span>
                      <textarea 
                        name="categories_raw"
                        defaultValue={tenantQuery.data?.categories?.join(', ') || ''} 
                        placeholder="e.g. Starters, Main Course, Drinks, Desserts"
                        className="w-full rounded-2xl border border-slate-200 px-4 py-3 outline-none focus:border-ember min-h-24"
                      />
                    </label>
                    <button className="w-full rounded-2xl bg-ink py-4 font-medium text-white transition hover:bg-slate-800" type="submit">
                       Update Menu Categories
                    </button>
                 </form>
              </article>
           </section>
        )}

        <section className="mt-6 rounded-[2rem] bg-white p-6 shadow-panel">
          <h2 className="font-display text-3xl text-ink">Reviews</h2>
          <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {reviewsQuery.data?.map((review) => (
              <article key={review.id} className="rounded-[1.5rem] border border-slate-100 p-4">
                <div className="flex items-center justify-between">
                  <p className="font-medium text-ink">{review.product.name}</p>
                  <span className="rounded-full bg-orange-50 px-3 py-1 text-sm text-ember">{review.rating}/5</span>
                </div>
                <p className="mt-3 text-sm text-slate-600">{review.comment}</p>
                <p className="mt-4 text-xs text-slate-400">
                  {review.order.customerPhone} | {new Date(review.createdAt).toLocaleDateString()}
                </p>
              </article>
            ))}
          </div>
        </section>
        </div>
      </main>

      {/* Toast Notifications */}
      {toast && (
        <div className="fixed bottom-8 left-1/2 -translate-x-1/2 z-[100] animate-in slide-in-from-bottom-4 duration-300">
          <div className={`px-6 py-3 rounded-2xl shadow-2xl font-bold text-sm tracking-wide flex items-center gap-2 border ${
            toast.type === 'success' 
             ? 'bg-ink text-white border-white/10' 
             : 'bg-red-600 text-white border-red-500'
          }`}>
            {toast.type === 'success' ? '✅' : '⚠️'}
            {toast.message}
          </div>
        </div>
      )}
    </>
  );
}
