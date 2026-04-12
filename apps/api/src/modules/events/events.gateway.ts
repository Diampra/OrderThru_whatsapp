import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';

@WebSocketGateway({
  cors: {
    origin: '*',
  },
})
export class EventsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private logger: Logger = new Logger('EventsGateway');

  handleConnection(client: Socket) {
    this.logger.log(`Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  @SubscribeMessage('joinTenant')
  handleJoinTenant(@ConnectedSocket() client: Socket, @MessageBody() tenantId: string) {
    this.logger.log(`Client ${client.id} joining room: tenant_${tenantId}`);
    client.join(`tenant_${tenantId}`);
    return { event: 'joined', data: tenantId };
  }

  emitNewOrder(tenantId: string, order: any) {
    this.logger.log(`Emitting new order for tenant: ${tenantId}`);
    this.server.to(`tenant_${tenantId}`).emit('order.created', order);
  }

  emitStaffNotification(tenantId: string, customerPhone: string, reason: string) {
    this.logger.log(`Emitting staff notification for tenant: ${tenantId}`);
    this.server.to(`tenant_${tenantId}`).emit('staff.notification', {
      customerPhone,
      reason,
      timestamp: new Date()
    });
  }
}
