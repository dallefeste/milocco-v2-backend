import { Injectable, NestMiddleware } from '@nestjs/common';
import { requestContext } from './request-context';

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(_req: unknown, _res: unknown, next: () => void) {
    requestContext.run({}, next);
  }
}
