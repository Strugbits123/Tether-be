import { Equals, IsString } from 'class-validator';

export class DeleteMemoirDto {
  @IsString()
  @Equals('delete my story', {
    message: 'Please type "delete my story" to confirm.',
  })
  confirm: string;
}
