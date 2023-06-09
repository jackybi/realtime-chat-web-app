import { InjectRepository } from '@nestjs/typeorm';
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { AuthService } from 'src/auth/auth.service';
import { User } from 'src/users/entities/user.entity';
import { Repository } from 'typeorm';
import { Server, Socket } from 'socket.io';
import { RCode } from 'src/config/rcode';
import { defaultGroupId } from 'src/config/global';
import { UseGuards } from '@nestjs/common';
import { ChatWsGuard } from './chatws.guard';
import { v4 as uuidv4 } from 'uuid';
import axios, { AxiosRequestConfig } from 'axios';
import { TranslateMessageService } from 'src/translate-message/translate-message.service';

@WebSocketGateway({ cors: true })
export class ChatGateway {
  @WebSocketServer()
  server: Server;

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly authService: AuthService,
    private readonly translateService: TranslateMessageService,
  ) {}

  async handleConnection(client: Socket): Promise<string> {
    console.log('Connection:', client.handshake.query);
    const token = client.handshake.query.token as string;
    const user = await this.authService.verifyUserToken(token);
    const { id } = user;

    client.join(defaultGroupId);

    console.log('user logon', id);

    client.broadcast.emit('userOnline', {
      code: RCode.OK,
      msg: 'userOnline',
      data: id,
    });

    if (id) {
      client.join(`${id}`);
    }
    return '连接成功';
  }

  async handleDisconnect(client: Socket): Promise<any> {
    const userId = client.handshake.query.userId;
    console.log('user offline', userId);

    client.broadcast.emit('userOffline', {
      code: RCode.OK,
      msg: 'userOffline',
      data: userId,
    });
  }

  @UseGuards(ChatWsGuard)
  @SubscribeMessage('groupTranslateEnMessage')
  async handleGroupAllMessage(
    @ConnectedSocket() client: Socket & { user: User },
    @MessageBody() data: GroupAllMessageDto,
  ): Promise<any> {
    const user = client.user;
    const messageId = await this.translateService.saveMessage({
      userId: user.id,
      content: data.content,
      messageType: 'text',
      tContent: '',
    });

    this.server.to(defaultGroupId).emit('groupTranslateMessage', {
      code: RCode.OK,
      msg: null,
      data: {
        ...data,
        userId: user.id,
        username: user.username,
        id: messageId,
        createTime: new Date().getTime(),
      },
    });

    const config: AxiosRequestConfig = {
      responseType: 'stream',
      headers: {
        'Content-Type': 'application/json',
        Authorization:
          'Bearer sk-f2x571LvBS3kRRoN1BIcnmzaBMB4ji5Rnj1E2XAXTqsLZYTy',
      },
    };

    await axios
      .post(
        'https://openai.f2api.com/v1/chat/completions',
        {
          model: 'gpt-3.5-turbo',
          messages: [
            {
              role: 'system',
              content:
                'I want you to act as an English translator, spelling corrector and improver. Keep the meaning same, but make them more literary.',
            },
            {
              role: 'user',
              content: data.content,
            },
          ],
          temperature: 0.7,
          stream: true,
        },
        config,
      )
      .then(async (res) => {
        const stream = res.data;
        let gptContent = '';
        let finished = false;
        stream.on('data', async (bData) => {
          gptContent += bData.toString();
          const content = gptContent.split('\n').reduce((prev, cur) => {
            if (cur.trim() === '') {
              return prev;
            }
            const jsonString = cur.replace(/^data: /, '');
            try {
              if (jsonString === '[DONE]') {
                finished = true;
                return prev;
              }
              return (
                prev + (JSON.parse(jsonString)?.choices[0].delta.content ?? '')
              );
            } catch (e) {
              return prev;
            }
          }, '');
          if (finished) {
            console.log(content);
            await this.translateService.updateMessage(messageId, {
              tContent: content,
            });
          }
          this.server.to(defaultGroupId).emit('groupTranslateMessage', {
            code: RCode.OK,
            msg: null,
            data: { tContent: content, id: messageId },
          });
        });
        stream.on('end', () => {
          finished = true;
        });
      })
      .catch(function (err) {
        if (err.response) {
          console.log('error:', err.response, err.response.body);
        } else {
          console.log('error:', err.message);
        }
      });
  }
}
